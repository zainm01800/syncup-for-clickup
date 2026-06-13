import prisma from "./db.server";

// ClickUp OAuth + API endpoints (see https://clickup.com/api).
const CLICKUP_AUTHORIZE_URL = "https://app.clickup.com/api";
const CLICKUP_TOKEN_URL = "https://api.clickup.com/api/v2/oauth/token";
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Build the ClickUp authorisation URL the merchant is sent to. The shop domain
 * is passed through `state` so the callback knows which shop is connecting.
 */
export function getClickUpAuthUrl(shop) {
  const params = new URLSearchParams({
    client_id: process.env.CLICKUP_CLIENT_ID || "",
    // ClickUp strips paths from redirect URIs — must use bare origin.
    redirect_uri: process.env.SHOPIFY_APP_URL || "",
    state: shop,
  });
  return `${CLICKUP_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange the authorisation `code` returned by ClickUp for an access token.
 * ClickUp expects the credentials as query parameters on a POST request.
 */
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
      `ClickUp token exchange failed (${response.status}): ${body}`,
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
      `ClickUp ${options.method || "GET"} ${path} failed (${response.status}): ${body}`,
    );
  }

  return response.json();
}

/** GET /team — the workspaces (teams) the connected user can access. */
export async function getTeams(token) {
  const data = await clickupRequest(`/team`, token);
  return data.teams || [];
}

/** GET /team/{team_id}/space — the spaces inside a workspace. */
export async function getSpaces(token, teamId) {
  const data = await clickupRequest(`/team/${teamId}/space`, token);
  return data.spaces || [];
}

/** GET /space/{space_id}/list — the (folderless) lists inside a space. */
export async function getSpaceLists(token, spaceId) {
  const data = await clickupRequest(`/space/${spaceId}/list`, token);
  return data.lists || [];
}

/**
 * Walk every workspace -> space -> list and return a flat array of lists the
 * merchant can sync orders into. Each entry is labelled with its space name so
 * duplicate list names remain distinguishable in the dropdown.
 */
export async function getAllLists(token) {
  const lists = [];
  const teams = await getTeams(token);

  for (const team of teams) {
    const spaces = await getSpaces(token, team.id);
    for (const space of spaces) {
      const spaceLists = await getSpaceLists(token, space.id);
      for (const list of spaceLists) {
        lists.push({
          id: list.id,
          name: `${space.name} / ${list.name}`,
        });
      }
    }
  }

  return lists;
}

/** POST /list/{list_id}/task — create a task in the chosen list. */
export async function createTask(token, listId, { name, description }) {
  return clickupRequest(`/list/${listId}/task`, token, {
    method: "POST",
    body: JSON.stringify({ name, description }),
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
// Persistence helpers (ClickUpConnection + OrderTask)
// ---------------------------------------------------------------------------

export async function getConnection(shop) {
  return prisma.clickUpConnection.findUnique({ where: { shopDomain: shop } });
}

export async function saveToken(shop, accessToken) {
  return prisma.clickUpConnection.upsert({
    where: { shopDomain: shop },
    update: { accessToken },
    create: { shopDomain: shop, accessToken },
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

export async function recordOrderTask(shop, shopifyOrderId, clickupTaskId) {
  return prisma.orderTask.upsert({
    where: {
      shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
    },
    update: { clickupTaskId },
    create: { shopDomain: shop, shopifyOrderId, clickupTaskId },
  });
}

export async function findOrderTask(shop, shopifyOrderId) {
  return prisma.orderTask.findUnique({
    where: {
      shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
    },
  });
}
