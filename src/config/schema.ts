import { z } from "zod";

export const environmentSchema = z
  .object({
    baseUrl: z.url(),
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
    authorization: z.string().min(1).optional(),
    tenantCode: z.string().min(1).optional()
  })
  .refine((environment) => !(environment.token && environment.tokenEnv), {
    message: "环境不能同时配置 token 和 tokenEnv"
  });

export const configSchema = z.object({
  currentEnvironment: z.string().min(1).optional(),
  environments: z.record(z.string(), environmentSchema).default({})
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type EadpConfig = z.infer<typeof configSchema>;

export const emptyConfig = (): EadpConfig => ({ environments: {} });
