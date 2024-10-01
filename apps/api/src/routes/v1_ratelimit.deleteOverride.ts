import type { App } from "@/pkg/hono/app";
import { createRoute, z } from "@hono/zod-openapi";

import { insertUnkeyAuditLog } from "@/pkg/audit";
import { rootKeyAuth } from "@/pkg/auth/root_key";
import { UnkeyApiError, openApiErrorResponses } from "@/pkg/errors";
import { and, eq, schema } from "@unkey/db";
import { buildUnkeyQuery } from "@unkey/rbac";
import { ratelimitOverrides } from "@unkey/db/src/schema";

const route = createRoute({
  tags: ["ratelimit"],
  operationId: "deleteOverride",
  method: "post",
  path: "/v1/ratelimit.deleteOverride",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            overrideId: z.string().openapi({
              description: "The id of the override you want to delete.",
              example: "override_123",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Sucessfully deleted a ratelimit",
      content: {
        "application/json": {
          schema: z.object({}),
        },
      },
    },
    ...openApiErrorResponses,
  },
});

export type Route = typeof route;
export type V1RatelimitDeleteOverrideRequest = z.infer<
  (typeof route.request.body.content)["application/json"]["schema"]
>;
export type V1RatelimitDeleteOverrideResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>;

export const registerV1RatelimitDeleteOverride = (app: App) =>
  app.openapi(route, async (c) => {
    const req = c.req.valid("json");
    const auth = await rootKeyAuth(
      c,
      buildUnkeyQuery(({ or }) => or("*", "ratelimit.*.delete_override")),
    );

    const { db, analytics } = c.get("services");

    const override = await db.primary.query.ratelimitOverrides.findFirst({
      where: (table, { eq, and }) =>
        and(eq(table.workspaceId, auth.authorizedWorkspaceId), eq(table.id, req.overrideId)),
    });
    if (!override) {
      throw new UnkeyApiError({
        code: "NOT_FOUND",
        message: `Ratelimit override ${req.overrideId} not found`,
      });
    }

    await db.primary.transaction(async (tx) => {
      await tx
        .delete(schema.ratelimitOverrides)
        .where(
          and(
            eq(schema.ratelimitOverrides.workspaceId, auth.authorizedWorkspaceId),
            eq(schema.ratelimitOverrides.id, req.overrideId),
          ),
        );

      await insertUnkeyAuditLog(c, tx, {
        workspaceId: auth.authorizedWorkspaceId,
        event: "ratelimit.delete_override",
        actor: {
          type: "key",
          id: auth.key.id,
        },
        description: `Deleted ratelimit ${override.id}`,
        resources: [
          {
            type: "role",
            id: override.id,
          },
        ],

        context: { location: c.get("location"), userAgent: c.get("userAgent") },
      });
    });

    c.executionCtx.waitUntil(
      analytics.ingestUnkeyAuditLogsTinybird({
        workspaceId: auth.authorizedWorkspaceId,
        event: "ratelimit.delete_override",
        actor: {
          type: "key",
          id: auth.key.id,
        },
        description: `Deleted ratelimit ${override.id}`,
        resources: [
          {
            type: "role",
            id: override.id,
          },
        ],

        context: { location: c.get("location"), userAgent: c.get("userAgent") },
      }),
    );

    return c.json({});
  });