import { z } from "zod";

export const environmentSchema = z
  .object({
    baseUrl: z.url(),
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional()
  })
  .refine((environment) => Boolean(environment.token) !== Boolean(environment.tokenEnv), {
    message: "环境必须且只能配置 token 或 tokenEnv"
  });

export const configSchema = z.object({
  currentEnvironment: z.string().min(1).optional(),
  environments: z.record(z.string(), environmentSchema).default({})
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type EadpConfig = z.infer<typeof configSchema>;

export const emptyConfig = (): EadpConfig => ({ environments: {} });
