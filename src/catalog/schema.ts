import { z } from "zod";

export const endpointSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  permission: z.enum(["read", "write", "delete", "publish"]).default("read"),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  requestSchema: z.record(z.string(), z.unknown()).optional(),
  example: z.unknown().optional()
});

export type EndpointDefinition = z.infer<typeof endpointSchema>;
