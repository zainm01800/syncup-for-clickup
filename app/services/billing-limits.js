import prisma from "../db.server.js";
import { PLANS } from "../plans.js";

/**
 * Validates whether a store is permitted to connect an additional resource target.
 * @throws Error if subscription validation constraint fails
 */
export async function assertBillingLimitEnforcement(shopDomain) {
  const sub = await prisma.subscription.findUnique({
    where: { shopDomain },
  });
  if (!sub) {
    throw new Error("Associated shop subscription not found");
  }

  const planName = sub.planName || "trial";
  const plan = PLANS[planName] || (planName === "trial" ? { listLimit: 5 } : { listLimit: 1 });
  const limit = plan.listLimit || 1;

  // Sum active connection targets across all active platform connections
  const activeTargetsCount = await prisma.syncTarget.count({
    where: {
      connection: { shopDomain, isActive: true },
      isActive: true,
    },
  });

  if (activeTargetsCount >= limit) {
    throw new Error(
      `SaaS Billing limit breached. Active connection node count (${activeTargetsCount}) matches or exceeds limit for the ${planName} tier (${limit}).`
    );
  }
}

/**
 * Safely deactivates previous targets and provisions a new platform connection in one atomic transaction.
 */
export async function executeWorkspacePlatformTransition(
  shopDomain,
  deactivateProvider,
  activateProvider,
  newConnectionData
) {
  await prisma.$transaction(async (tx) => {
    // 1. Locate existing connection targets for the platform being deactivated
    const activeOldConnection = await tx.platformConnection.findFirst({
      where: { shopDomain, provider: deactivateProvider },
    });

    if (activeOldConnection) {
      // Soft-deactivate all targets to clear billing limit slots
      await tx.syncTarget.updateMany({
        where: { connectionId: activeOldConnection.id },
        data: { isActive: false },
      });

      // Mark the parent connection as inactive
      await tx.platformConnection.update({
        where: { id: activeOldConnection.id },
        data: { isActive: false },
      });
    }

    // 2. Provision or update the connection for the new platform being activated
    const targetConnection = await tx.platformConnection.upsert({
      where: {
        shopDomain_provider: {
          shopDomain,
          provider: activateProvider,
        },
      },
      update: {
        encryptedAccessToken: newConnectionData.encryptedAccessToken,
        isActive: true,
      },
      create: {
        shopDomain,
        provider: activateProvider,
        encryptedAccessToken: newConnectionData.encryptedAccessToken,
        isActive: true,
      },
    });

    // 3. Populate target metadata for the new platform
    const metadataUpdate = {
      workspaceId: newConnectionData.metadata.workspaceId,
      fieldMappings: newConnectionData.metadata.fieldMappings || "[]",
    };

    if (activateProvider === "CLICKUP") {
      metadataUpdate.workspaceName = newConnectionData.metadata.workspaceName || "Default Workspace";
      await tx.clickUpMetadata.upsert({
        where: { connectionId: targetConnection.id },
        update: metadataUpdate,
        create: {
          connectionId: targetConnection.id,
          ...metadataUpdate,
        },
      });
    } else if (activateProvider === "MONDAY") {
      await tx.mondayMetadata.upsert({
        where: { connectionId: targetConnection.id },
        update: metadataUpdate,
        create: {
          connectionId: targetConnection.id,
          ...metadataUpdate,
        },
      });
    } else if (activateProvider === "NOTION") {
      await tx.notionMetadata.upsert({
        where: { connectionId: targetConnection.id },
        update: metadataUpdate,
        create: {
          connectionId: targetConnection.id,
          ...metadataUpdate,
        },
      });
    }

    // 4. Provision connection targets for the newly activated platform
    for (const target of newConnectionData.targetResources) {
      await tx.syncTarget.upsert({
        where: {
          connectionId_targetResourceId: {
            connectionId: targetConnection.id,
            targetResourceId: target.id,
          },
        },
        update: {
          targetResourceName: target.name,
          isActive: true,
        },
        create: {
          connectionId: targetConnection.id,
          targetResourceId: target.id,
          targetResourceName: target.name,
          isActive: true,
        },
      });
    }

    // 5. Run the billing limits validation check within the transaction context
    const sub = await tx.subscription.findUnique({ where: { shopDomain } });
    const planName = sub?.planName || "trial";
    const plan = PLANS[planName] || (planName === "trial" ? { listLimit: 5 } : { listLimit: 1 });
    const limit = plan.listLimit || 1;

    const totalActiveTargets = await tx.syncTarget.count({
      where: {
        connection: { shopDomain, isActive: true },
        isActive: true,
      },
    });

    if (totalActiveTargets > limit) {
      throw new Error(
        `Workspace platform transition aborted. Configured targets (${totalActiveTargets}) exceed subscription tier limits (${limit}).`
      );
    }
  });
}
