import { decryptToken } from "../crypto.server.js";
import { ClickUpAdapter, MondayAdapter, NotionAdapter } from "./core.js";

export class IntegrationFactory {
  /**
   * Instantiates an operational adapter class based on the provider config.
   * @param {string} provider CLICKUP, MONDAY, or NOTION.
   * @param {string} encryptedAccessToken Encrypted OAuth or API token.
   * @returns {Promise<IntegrationAdapter>} The platform adapter instance.
   */
  static async getAdapter(provider, encryptedAccessToken) {
    if (!encryptedAccessToken) {
      throw new Error(`Access token missing for provider: ${provider}`);
    }
    const decryptedToken = await decryptToken(encryptedAccessToken);
    if (!decryptedToken) {
      throw new Error(`Failed to decrypt access token for provider: ${provider}`);
    }

    const p = String(provider).toUpperCase();
    switch (p) {
      case "CLICKUP":
        return new ClickUpAdapter(decryptedToken);
      case "MONDAY":
        return new MondayAdapter(decryptedToken);
      case "NOTION":
        return new NotionAdapter(decryptedToken);
      default:
        throw new Error(`Unsupported integration provider value: ${provider}`);
    }
  }
}
