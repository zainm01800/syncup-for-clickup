import prisma from "./db.server";
import { encryptToken, decryptToken } from "./crypto.server";

export async function fetchShopifyCustomer(shop, customerId) {
  if (!customerId) return null;
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { accessToken: true, scope: true },
  });
  console.log(`[DEBUG fetchCustomer] shop=${shop} id=${customerId} hasToken=${!!session?.accessToken} scope=${session?.scope}`);
  if (!session?.accessToken) return null;
  try {
    const res = await fetch(
      `https://${shop}/admin/api/2024-01/customers/${customerId}.json`,
      { headers: { "X-Shopify-Access-Token": session.accessToken } }
    );
    console.log(`[DEBUG fetchCustomer] status=${res.status}`);
    if (!res.ok) return null;
    const { customer } = await res.json();
    console.log(`[DEBUG fetchCustomer] customer=${JSON.stringify({ first_name: customer?.first_name, last_name: customer?.last_name, email: customer?.email, default_address: customer?.default_address?.name, keys: customer ? Object.keys(customer) : null })}`);
    return customer ?? null;
  } catch (err) {
    console.log(`[DEBUG fetchCustomer] error=${err.message}`);
    return null;
  }
}

// ClickUp OAuth + API endpoints (see https://clickup.com/api).
const CLICKUP_AUTHORIZE_URL = "https://app.clickup.com/api";
const CLICKUP_TOKEN_URL = "https://api.clickup.com/api/v2/oauth/token";
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function getClickUpAuthUrl(shop) {
  const params = new URLSearchParams({
    client_id: process.env.CLICKUP_CLIENT_ID || "",
    // ClickUp strips paths from redirect URIs — must use bare origin.
    redirect_uri: process.env.SHOPIFY_APP_URL || "",
    state: shop,
  });
  return `${CLICKUP_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeClickUpCode(code) {
  const params = new URLSearchParams({
    client_id: process.env.CLICKUP_CLIENT_ID || "",
    client_secret: process.env.CLICKUP_CLIENT_SECRET || "",
    code,
    redirect_uri: process.env.SHOPIFY_APP_URL || "",
  });

  const response = await fetch(`${CLICKUP_TOKEN_URL}?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ClickUp token exchange failed (${response.status}): ${body}`
    );
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("ClickUp token exchange did not return an access_token");
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// ClickUp REST API helpers
// ClickUp expects the access token directly in the Authorization header
// (no "Bearer " prefix).
// ---------------------------------------------------------------------------

async function clickupRequest(path, token, options = {}) {
  const response = await fetch(`${CLICKUP_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ClickUp ${options.method || "GET"} ${path} failed (${response.status}): ${body}`
    );
  }

  return response.json();
}

// Retry once after a short delay. Webhook handlers need to stay under 5s,
// so we use a 1-second backoff rather than the full 5s called for in spec.
export async function withRetry(fn, retries = 1, delayMs = 1000) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

/** GET /team — the workspaces (teams) the connected user can access. */
export async function getTeams(token) {
  const data = await clickupRequest(`/team`, token);
  return data.teams || [];
}

/** GET /team/{team_id}/space */
export async function getSpaces(token, teamId) {
  const data = await clickupRequest(`/team/${teamId}/space`, token);
  return data.spaces || [];
}

/** GET /space/{space_id}/folder */
async function getFolders(token, spaceId) {
  const data = await clickupRequest(`/space/${spaceId}/folder`, token);
  return data.folders || [];
}

/** GET /space/{space_id}/list — folderless lists inside a space. */
async function getSpaceLists(token, spaceId) {
  const data = await clickupRequest(`/space/${spaceId}/list`, token);
  return data.lists || [];
}

/** GET /folder/{folder_id}/list — lists inside a folder. */
async function getFolderLists(token, folderId) {
  const data = await clickupRequest(`/folder/${folderId}/list`, token);
  return data.lists || [];
}

/**
 * Walk every workspace → space → folder → list (and folderless lists) and
 * return a flat array of objects { id, name } the merchant can sync into.
 * Each name is prefixed with its path so duplicates are distinguishable.
 */
export async function getAllLists(token) {
  const lists = [];
  const teams = await getTeams(token);

  for (const team of teams) {
    const spaces = await getSpaces(token, team.id);
    for (const space of spaces) {
      // Folderless lists
      const spaceListItems = await getSpaceLists(token, space.id);
      for (const list of spaceListItems) {
        lists.push({ id: list.id, name: `${space.name} / ${list.name}` });
      }
      // Lists inside folders
      const folders = await getFolders(token, space.id);
      for (const folder of folders) {
        const folderLists = await getFolderLists(token, folder.id);
        for (const list of folderLists) {
          lists.push({
            id: list.id,
            name: `${space.name} / ${folder.name} / ${list.name}`,
          });
        }
      }
    }
  }

  return lists;
}

/** POST /list/{list_id}/task — create a task in the chosen list. */
export async function createTask(token, listId, { name, description, priority, startDate, dueDate, tags }) {
  const body = { name, description };
  if (priority !== undefined) body.priority = priority;
  if (startDate !== undefined) body.start_date = startDate;
  if (dueDate !== undefined) body.due_date = dueDate;
  if (tags !== undefined) body.tags = tags;

  return clickupRequest(`/list/${listId}/task`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** PUT /task/{task_id} — mark a task complete. */
export async function completeTask(token, taskId) {
  return clickupRequest(`/task/${taskId}`, token, {
    method: "PUT",
    body: JSON.stringify({ status: "complete" }),
  });
}

// ---------------------------------------------------------------------------
// Persistence helpers — ClickUpConnection
// ---------------------------------------------------------------------------

export async function getConnection(shop) {
  const conn = await prisma.clickUpConnection.findUnique({
    where: { shopDomain: shop },
  });
  if (!conn) return null;
  const accessToken = await decryptToken(conn.accessToken);
  // null means old-format token that can't be decrypted — treat as disconnected
  if (!accessToken) return null;
  return { ...conn, accessToken };
}

export async function saveToken(shop, accessToken, workspaceName = null) {
  const encryptedToken = await encryptToken(accessToken);
  const data = { accessToken: encryptedToken };
  if (workspaceName) data.workspaceName = workspaceName;
  return prisma.clickUpConnection.upsert({
    where: { shopDomain: shop },
    update: data,
    create: { shopDomain: shop, ...data },
  });
}

export async function saveList(shop, listId, listName) {
  return prisma.clickUpConnection.update({
    where: { shopDomain: shop },
    data: { listId, listName },
  });
}

export async function disconnect(shop) {
  return prisma.clickUpConnection.deleteMany({ where: { shopDomain: shop } });
}

// ---------------------------------------------------------------------------
// Persistence helpers — OrderTask
// ---------------------------------------------------------------------------

export async function recordOrderTask(shop, shopifyOrderId, clickupTaskId, status = "synced") {
  return prisma.orderTask.upsert({
    where: {
      shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
    },
    update: { clickupTaskId, status },
    create: { shopDomain: shop, shopifyOrderId, clickupTaskId, status },
  });
}

export async function findOrderTask(shop, shopifyOrderId) {
  return prisma.orderTask.findUnique({
    where: {
      shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
    },
  });
}

// Atomically claims an order slot before calling ClickUp.
// Returns true if this caller won the race, false if another webhook already claimed it.
export async function claimOrderSlot(shop, shopifyOrderId) {
  try {
    await prisma.orderTask.create({
      data: { shopDomain: shop, shopifyOrderId, clickupTaskId: "pending", status: "pending" },
    });
    return true;
  } catch (e) {
    // P2002 = Prisma unique constraint; 23505 = PostgreSQL native code (Neon adapter)
    if (e.code === "P2002" || e.code === "23505") return false;
    throw e;
  }
}

export async function updateOrderTaskStatus(shop, shopifyOrderId, status) {
  return prisma.orderTask.updateMany({
    where: { shopDomain: shop, shopifyOrderId },
    data: { status },
  });
}

// ---------------------------------------------------------------------------
// Activity log — fire-and-forget, never blocks callers
// ---------------------------------------------------------------------------

export function logActivity(shop, eventType, description) {
  prisma.activityLog
    .create({ data: { shopDomain: shop, eventType, description } })
    .catch((e) => console.error("logActivity failed:", e));
}

export async function getRecentActivity(shop, limit = 5) {
  return prisma.activityLog.findMany({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
