const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts standard order mapping variables from raw Shopify JSON.
 */
export function extractOrderSourceFields(order, customerName, shippingCost) {
  const email = order.customer?.email || order.email || "";
  const phone = order.customer?.phone || order.billing_address?.phone || order.shipping_address?.phone || "";
  const total = order.total_price ?? "0.00";
  const subtotal = order.subtotal_price ?? "0.00";
  
  let shippingAddress = "";
  const addr = order.shipping_address;
  if (addr) {
    const addrParts = [
      addr.address1,
      addr.address2,
      [addr.city, addr.province_code || addr.province, addr.zip]
        .filter(Boolean)
        .join(", "),
      addr.country,
    ].filter(Boolean);
    shippingAddress = addrParts.join(", ");
  }

  const orderNotes = order.note?.trim() || "";
  const createdAt = order.created_at || new Date().toISOString();

  return {
    order_number: String(order.order_number || order.id || ""),
    customer_name: customerName || "Guest",
    customer_email: email,
    customer_phone: phone,
    total_price: total,
    subtotal_price: subtotal,
    shipping_price: shippingCost,
    shipping_address: shippingAddress,
    order_notes: orderNotes,
    created_at: createdAt
  };
}

/**
 * Base abstract Integration Adapter class.
 */
export class IntegrationAdapter {
  async createRecord() {
    throw new Error("createRecord() not implemented");
  }

  async completeRecord() {
    throw new Error("completeRecord() not implemented");
  }

  async postComment() {
    throw new Error("postComment() not implemented");
  }

  async testConnection() {
    throw new Error("testConnection() not implemented");
  }

  async fetchTargets() {
    throw new Error("fetchTargets() not implemented");
  }

  async fetchFields() {
    throw new Error("fetchFields() not implemented");
  }
}

/**
 * Helper to call ClickUp API REST requests.
 */
async function clickupRequest(endpoint, token, options = {}) {
  const url = `https://api.clickup.com/api/v2${endpoint}`;
  const headers = {
    Authorization: token,
    "Content-Type": "application/json",
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API failed at ${endpoint} (${res.status}): ${body}`);
  }
  return res.json();
}

function normalizeClickUpFieldType(type) {
  if (typeof type === "number" || !isNaN(Number(type))) {
    const typeNum = Number(type);
    const mappings = {
      0: "attachment",
      1: "checkbox",
      2: "currency",
      3: "date",
      4: "dropdown",
      5: "email",
      6: "emoji",
      7: "formula",
      8: "location",
      9: "number",
      10: "people",
      11: "phone",
      12: "progress",
      13: "rating",
      14: "relationship",
      15: "rollup",
      16: "short_text",
      17: "tasks",
      18: "text",
      19: "url"
    };
    return mappings[typeNum] || "text";
  }
  return String(type || "").toLowerCase();
}

/**
 * ClickUp Integration Adapter
 */
export class ClickUpAdapter extends IntegrationAdapter {
  constructor(apiToken) {
    super();
    this.apiToken = apiToken;
  }

  async createRecord(targetResourceId, { name, description, priority, startDate, dueDate, tags, rawOrder, customerName, shippingCost, fieldMappings, isFreePlan, subtasks, attachments }) {
    const body = {
      name,
      description,
      priority: priority ?? 3,
      tags: tags ?? ["shopify-order"],
    };
    if (startDate) body.start_date = startDate;
    if (dueDate) body.due_date = dueDate;

    // 2. Set custom fields if not free plan (batch set in initial creation body)
    if (!isFreePlan && fieldMappings) {
      let mappings = [];
      try {
        mappings = typeof fieldMappings === "string" ? JSON.parse(fieldMappings) : fieldMappings;
      } catch (e) {
        console.error("Failed to parse ClickUp mappings in adapter:", e);
      }

      if (Array.isArray(mappings) && mappings.length > 0) {
        const orderValues = extractOrderSourceFields(rawOrder, customerName, shippingCost);
        const customFieldsBody = [];
        for (const mapping of mappings) {
          const rawVal = orderValues[mapping.shopifySourceField];
          if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
            try {
              const formattedVal = this.formatFieldForClickUp(rawVal, mapping.clickupFieldType);
              customFieldsBody.push({
                id: mapping.clickupFieldId,
                value: formattedVal,
              });
            } catch (err) {
              console.error(`Failed to format field ${mapping.clickupFieldId}:`, err);
            }
          }
        }
        if (customFieldsBody.length > 0) {
          body.custom_fields = customFieldsBody;
        }
      }
    }

    // 1. Create main task (including custom fields in the POST body to avoid sequential writes)
    const task = await clickupRequest(`/list/${targetResourceId}/task`, this.apiToken, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const taskId = task.id;

    // 3. Process attachments
    if (attachments && attachments.length > 0) {
      for (const asset of attachments) {
        try {
          await this.uploadAttachment(taskId, asset.url, asset.filename);
          await sleep(800); // Throttling
        } catch (err) {
          console.error(`Failed to upload attachment ${asset.filename} to ClickUp:`, err);
        }
      }
    }

    // 4. Create subtasks
    if (subtasks && subtasks.length > 0) {
      for (const subName of subtasks) {
        try {
          await clickupRequest(`/list/${targetResourceId}/task`, this.apiToken, {
            method: "POST",
            body: JSON.stringify({
              name: subName,
              parent: taskId,
              priority: priority ?? 3,
            }),
          });
          await sleep(800); // Throttling
        } catch (err) {
          console.error(`Failed to create subtask ${subName} in ClickUp:`, err);
        }
      }
    }

    return taskId;
  }

  async completeRecord(targetRecordId) {
    await clickupRequest(`/task/${targetRecordId}`, this.apiToken, {
      method: "PUT",
      body: JSON.stringify({ status: "complete" }),
    });
  }

  async postComment(targetRecordId, text) {
    await clickupRequest(`/task/${targetRecordId}/comment`, this.apiToken, {
      method: "POST",
      body: JSON.stringify({ comment_text: text }),
    });
  }

  async testConnection() {
    try {
      await clickupRequest("/user", this.apiToken);
      return true;
    } catch {
      return false;
    }
  }

  formatFieldForClickUp(value, type) {
    if (value === null || value === undefined) return null;
    const stringVal = String(value).trim();
    if (!stringVal) return null;

    const normalizedType = normalizeClickUpFieldType(type);
    switch (normalizedType) {
      case "number":
      case "currency": {
        const parsed = parseFloat(stringVal.replace(/[^0-9.-]/g, ""));
        return isNaN(parsed) ? null : parsed;
      }
      case "date": {
        const parsedDate = new Date(stringVal);
        return isNaN(parsedDate.getTime()) ? null : parsedDate.getTime();
      }
      case "boolean":
      case "checkbox": {
        return stringVal === "true" || stringVal === "1" || value === true;
      }
      default:
        return stringVal;
    }
  }

  async uploadAttachment(taskId, fileUrl, filename) {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    const blob = await response.blob();
    const formData = new FormData();
    formData.append("attachment", blob, filename);

    const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
      method: "POST",
      headers: { Authorization: this.apiToken },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickUp upload failed (${res.status}): ${text}`);
    }
  }

  async fetchTargets() {
    const lists = [];
    const teamsData = await clickupRequest(`/team`, this.apiToken);
    const teams = teamsData.teams || [];

    for (const team of teams) {
      const spacesData = await clickupRequest(`/team/${team.id}/space`, this.apiToken);
      const spaces = spacesData.spaces || [];
      for (const space of spaces) {
        // Folderless lists
        const spaceListData = await clickupRequest(`/space/${space.id}/list`, this.apiToken);
        const spaceLists = spaceListData.lists || [];
        for (const list of spaceLists) {
          lists.push({ id: list.id, name: `${space.name} / ${list.name}` });
        }
        // Lists inside folders
        const foldersData = await clickupRequest(`/space/${space.id}/folder`, this.apiToken);
        const folders = foldersData.folders || [];
        for (const folder of folders) {
          const folderListData = await clickupRequest(`/folder/${folder.id}/list`, this.apiToken);
          const folderLists = folderListData.lists || [];
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

  async fetchFields(targetResourceId) {
    const data = await clickupRequest(`/list/${targetResourceId}/field`, this.apiToken);
    const fields = data.fields || [];
    return fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
    }));
  }
}


/**
 * Monday.com Integration Adapter
 */
export class MondayAdapter extends IntegrationAdapter {
  constructor(apiToken) {
    super();
    this.apiToken = apiToken;
    this.endpoint = "https://api.monday.com/v2";
  }

  async graphql(query, variables = {}) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: this.apiToken,
        "Content-Type": "application/json",
        "API-Version": "2024-04",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Monday API GraphQL failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    if (data.errors) {
      throw new Error(`Monday GraphQL error: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
  }

  async testConnection() {
    try {
      await this.graphql("{ me { id } }");
      return true;
    } catch {
      return false;
    }
  }

  formatFieldForMonday(value, type) {
    if (value === null || value === undefined) return null;
    const stringVal = String(value).trim();
    if (!stringVal) return null;

    const t = String(type || "").toLowerCase();
    if (t === "status" || t === "color") {
      return { label: stringVal };
    } else if (t === "date") {
      const dateObj = new Date(stringVal);
      if (isNaN(dateObj.getTime())) return null;
      return { date: dateObj.toISOString().split("T")[0] };
    } else if (t === "numbers" || t === "numeric" || t === "number") {
      const parsed = parseFloat(stringVal.replace(/[^0-9.-]/g, ""));
      return isNaN(parsed) ? null : String(parsed);
    } else if (t === "email") {
      return { email: stringVal, text: stringVal };
    } else if (t === "phone") {
      return { phone: stringVal, countryShortName: "US" };
    }
    return stringVal;
  }

  async createRecord(targetResourceId, { name, description, rawOrder, customerName, shippingCost, fieldMappings, subtasks, attachments }) {
    // 1. Build column values from mappings
    const columnValues = {};

    let mappings = [];
    try {
      mappings = typeof fieldMappings === "string" ? JSON.parse(fieldMappings) : fieldMappings;
    } catch (e) {
      console.error("Failed to parse Monday mappings in adapter:", e);
    }

    if (Array.isArray(mappings) && mappings.length > 0) {
      const orderValues = extractOrderSourceFields(rawOrder, customerName, shippingCost);
      for (const mapping of mappings) {
        const rawVal = orderValues[mapping.shopifySourceField];
        if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
          const colId = mapping.mondayColumnId || mapping.clickupFieldId;
          const colType = mapping.mondayColumnType || mapping.clickupFieldType || "text";
          columnValues[colId] = this.formatFieldForMonday(rawVal, colType);
        }
      }
    }

    const query = `
      mutation ($boardId: ID!, $itemName: String!, $columnVals: JSON!) {
        create_item (board_id: $boardId, item_name: $itemName, column_values: $columnVals) {
          id
        }
      }
    `;

    const variables = {
      boardId: targetResourceId,
      itemName: name,
      columnVals: JSON.stringify(columnValues),
    };

    // 2. Create Monday item
    const data = await this.graphql(query, variables);
    const itemId = data.create_item.id;

    // 3. Post description as an update (Monday's native comment box)
    if (description) {
      const updateQuery = `
        mutation ($itemId: ID!, $body: String!) {
          create_update (item_id: $itemId, body: $body) {
            id
          }
        }
      `;
      try {
        await this.graphql(updateQuery, { itemId, body: description });
        await sleep(800);
      } catch (err) {
        console.error("Failed to write Monday item update comment:", err);
      }
    }

    // 4. Create sub-items (subtasks)
    if (subtasks && subtasks.length > 0) {
      const subQuery = `
        mutation ($parentId: ID!, $itemName: String!) {
          create_subitem (parent_item_id: $parentId, item_name: $itemName) {
            id
          }
        }
      `;
      for (const subName of subtasks) {
        try {
          await this.graphql(subQuery, { parentId: itemId, itemName: subName });
          await sleep(800);
        } catch (err) {
          console.error(`Failed to create Monday subitem ${subName}:`, err);
        }
      }
    }

    // 5. Upload files (links written to updates/comments box)
    if (attachments && attachments.length > 0) {
      let linksText = "🎨 **Production Assets:**\n";
      for (const asset of attachments) {
        linksText += `• [${asset.filename}](${asset.url})\n`;
      }
      try {
        await this.graphql(`
          mutation ($itemId: ID!, $body: String!) {
            create_update (item_id: $itemId, body: $body) {
              id
            }
          }
        `, { itemId, body: linksText });
        await sleep(800);
      } catch (err) {
        console.error("Failed to append asset links updates to Monday:", err);
      }
    }

    return itemId;
  }

  async completeRecord(targetRecordId) {
    const query = `
      mutation ($itemId: ID!, $columnVals: JSON!) {
        change_multiple_column_values (item_id: $itemId, column_values: $columnVals) {
          id
        }
      }
    `;
    const variables = {
      itemId: targetRecordId,
      columnVals: JSON.stringify({ status: { label: "Done" } }),
    };
    try {
      await this.graphql(query, variables);
    } catch (err) {
      console.warn("Monday status set failed (custom status column may not be named 'status'). Falling back to update comment.");
      await this.graphql(`
        mutation ($itemId: ID!, $body: String!) {
          create_update (item_id: $itemId, body: $body) {
            id
          }
        }
      `, { itemId: targetRecordId, body: "✅ Order has been FULFILLED in Shopify." });
    }
  }

  async postComment(targetRecordId, text) {
    const query = `
      mutation ($itemId: ID!, $body: String!) {
        create_update (item_id: $itemId, body: $body) {
          id
        }
      }
    `;
    await this.graphql(query, { itemId: targetRecordId, body: text });
  }

  async fetchTargets() {
    const query = `
      query {
        boards (limit: 100) {
          id
          name
        }
      }
    `;
    const data = await this.graphql(query);
    const boards = data.boards || [];
    return boards.map((b) => ({ id: b.id, name: b.name }));
  }

  async fetchFields(targetResourceId) {
    const query = `
      query ($boardId: [ID!]) {
        boards (ids: $boardId) {
          columns {
            id
            title
            type
          }
        }
      }
    `;
    const data = await this.graphql(query, { boardId: [targetResourceId] });
    const board = data.boards?.[0];
    const columns = board?.columns || [];
    return columns.map((c) => ({
      id: c.id,
      name: c.title,
      type: c.type,
    }));
  }
}


/**
 * Notion Integration Adapter
 */
export class NotionAdapter extends IntegrationAdapter {
  constructor(apiToken) {
    super();
    this.apiToken = apiToken;
    this.baseUrl = "https://api.notion.com/v1";
  }

  async notionFetch(endpoint, options = {}) {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion API failed at ${endpoint} (${res.status}): ${body}`);
    }
    return res.json();
  }

  async testConnection() {
    try {
      await this.notionFetch("/users/me");
      return true;
    } catch {
      return false;
    }
  }

  async createRecord(targetResourceId, { name, description, rawOrder, customerName, shippingCost, fieldMappings, subtasks, attachments }) {
    // 1. Fetch database properties to locate the primary title property key and check property existence/types
    const dbDef = await this.notionFetch(`/databases/${targetResourceId}`);
    const propertiesDef = dbDef.properties || {};
    const titleKey = Object.keys(propertiesDef).find(k => propertiesDef[k]?.type === "title") || "Name";

    const properties = {
      [titleKey]: {
        title: [
          { text: { content: name } },
        ],
      },
    };

    let mappings = [];
    try {
      mappings = typeof fieldMappings === "string" ? JSON.parse(fieldMappings) : fieldMappings;
    } catch (e) {
      console.error("Failed to parse Notion mappings in adapter:", e);
    }

    if (Array.isArray(mappings) && mappings.length > 0) {
      const orderValues = extractOrderSourceFields(rawOrder, customerName, shippingCost);
      for (const mapping of mappings) {
        const rawVal = orderValues[mapping.shopifySourceField];
        if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
          const propId = mapping.notionPropertyId || mapping.clickupFieldId;
          const propDef = propertiesDef[propId];
          if (!propDef) continue; // Skip mapping if the column doesn't exist in Notion database

          const type = (propDef.type || "rich_text").toLowerCase();
          if (type === "title" || propId === titleKey) {
            properties[propId] = {
              title: [
                { text: { content: String(rawVal) } },
              ],
            };
          } else if (type === "number") {
            properties[propId] = { number: parseFloat(String(rawVal).replace(/[^0-9.-]/g, "")) };
          } else if (type === "email") {
            properties[propId] = { email: String(rawVal) };
          } else if (type === "phone_number") {
            properties[propId] = { phone_number: String(rawVal) };
          } else if (type === "url") {
            properties[propId] = { url: String(rawVal) };
          } else if (type === "checkbox") {
            properties[propId] = { checkbox: rawVal === "true" || rawVal === "1" || rawVal === true };
          } else if (type === "select" || type === "status") {
            properties[propId] = { [type]: { name: String(rawVal) } };
          } else if (type === "multi_select") {
            properties[propId] = { multi_select: [{ name: String(rawVal) }] };
          } else {
            properties[propId] = { rich_text: [{ text: { content: String(rawVal) } }] };
          }
        }
      }
    }

    const children = [];
    if (description) {
      const descLines = description.split("\n");
      for (const line of descLines) {
        if (line.trim() !== "") {
          children.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: line } }],
            },
          });
        }
      }
    }

    console.log("NOTION SYNC REQUEST payload:", JSON.stringify({
      parent: { database_id: targetResourceId },
      properties,
      children: children.length > 0 ? children.slice(0, 100) : undefined,
    }, null, 2));

    const page = await this.notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: targetResourceId },
        properties,
        children: children.length > 0 ? children.slice(0, 100) : undefined,
      }),
    });

    const pageId = page.id;

    if (subtasks && subtasks.length > 0) {
      for (const subName of subtasks) {
        try {
          await this.notionFetch("/pages", {
            method: "POST",
            body: JSON.stringify({
              parent: { page_id: pageId },
              properties: {
                title: [
                  { text: { content: subName } }
                ]
              }
            })
          });
          await sleep(400); // Throttle to stay under Notion's rate limits
        } catch (err) {
          console.error(`Failed to create Notion child page for subtask "${subName}":`, err);
        }
      }
    }

    if (attachments && attachments.length > 0) {
      const assetBlocks = [
        {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ text: { content: "🎨 Production Assets" } }],
          },
        },
      ];
      for (const asset of attachments) {
        const isImage = /\.(png|jpe?g|gif|webp|bmp)(\?.*)?$/i.test(asset.filename || asset.url);
        if (isImage) {
          assetBlocks.push({
            object: "block",
            type: "image",
            image: {
              type: "external",
              external: { url: asset.url }
            }
          });
        } else {
          assetBlocks.push({
            object: "block",
            type: "file",
            file: {
              type: "external",
              external: { url: asset.url }
            }
          });
        }
      }

      try {
        await this.notionFetch(`/blocks/${pageId}/children`, {
          method: "PATCH",
          body: JSON.stringify({ children: assetBlocks }),
        });
        await sleep(800);
      } catch (err) {
        console.error("Failed to append files block to Notion:", err);
      }
    }

    return pageId;
  }

  async completeRecord(targetRecordId) {
    try {
      await this.notionFetch(`/pages/${targetRecordId}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            Status: {
              select: { name: "Done" },
            },
          },
        }),
      });
    } catch (err) {
      console.warn("Notion Status column set failed. Appending completion note instead.");
      await this.notionFetch(`/blocks/${targetRecordId}/children`, {
        method: "PATCH",
        body: JSON.stringify({
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ text: { content: "✅ Order has been FULFILLED in Shopify.", annotations: { bold: true, color: "green" } } }],
              },
            },
          ],
        }),
      });
    }
  }

  async postComment(targetRecordId, text) {
    try {
      await this.notionFetch("/comments", {
        method: "POST",
        body: JSON.stringify({
          parent: { page_id: targetRecordId },
          rich_text: [{ text: { content: text } }],
        }),
      });
    } catch (err) {
      console.error("Failed to post comment to Notion page:", err);
    }
  }

  async fetchTargets() {
    const data = await this.notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        filter: {
          value: "database",
          property: "object",
        },
      }),
    });
    const results = data.results || [];
    return results.map((db) => {
      const titleObj = db.title || [];
      const name = titleObj.map((t) => t.plain_text).join("") || "Unnamed Database";
      return { id: db.id, name };
    });
  }

  async fetchFields(targetResourceId) {
    const db = await this.notionFetch(`/databases/${targetResourceId}`, {
      method: "GET",
    });
    const properties = db.properties || {};
    return Object.entries(properties).map(([propName, propDef]) => ({
      id: propName,
      name: propName,
      type: propDef.type,
    }));
  }
}

