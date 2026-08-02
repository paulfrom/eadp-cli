import { z } from "zod";

export const endpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  domain: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"]),
  path: z.string().startsWith("/"),
  permission: z.enum(["read", "write", "delete", "publish"]).default("read"),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  callable: z.boolean().default(true),
  source: z.string().optional(),
  queryParameters: z
    .array(
      z.object({
        name: z.string().min(1),
        required: z.boolean().default(false),
        description: z.string().default(""),
        example: z.unknown().optional()
      })
    )
    .default([]),
  resourceExamples: z.array(z.string().min(1)).default([]),
  requestSchema: z.record(z.string(), z.unknown()).optional(),
  example: z.unknown().optional()
});

export type EndpointDefinition = z.infer<typeof endpointSchema>;
