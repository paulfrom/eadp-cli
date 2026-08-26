import { z } from "zod";
import { EADP_PAGE_SIZE } from "../../http/pagination.js";
import type { ResourceContract } from "../core/contracts.js";

export const RESOURCE_CONTRACT_SCHEMA_VERSION = "eadp.resource-contract.v1" as const;

const relativeEndpointPath = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.split("/").includes("..") && !value.includes("://"),
  "必须是服务内相对路径，不能包含绝对 URL、前导 / 或 .."
);

const endpointSchema = z.object({
  path: relativeEndpointPath,
  method: z.enum(["GET", "POST", "PUT", "PATCH"])
}).strict();

const removeEndpointSchema = z.object({
  path: relativeEndpointPath,
  method: z.enum(["DELETE", "POST"]),
  idField: z.string().min(1),
  idPlacement: z.enum(["path", "query", "body"])
}).strict();

const lookupEndpointSchema = z.object({
  path: relativeEndpointPath,
  method: z.enum(["GET", "POST"]),
  idField: z.string().min(1),
  idPlacement: z.enum(["query", "body"])
}).strict();

const rollbackSchema = z.object({
  service: z.string().min(1),
  resource: z.string().min(1),
  remove: removeEndpointSchema,
  lookup: lookupEndpointSchema
}).strict();

const deletionSchema = rollbackSchema.extend({
  restore: z.object({
    path: relativeEndpointPath,
    method: z.enum(["POST", "PUT", "PATCH"])
  }).strict()
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  service: z.string().min(1),
  query: endpointSchema,
  save: endpointSchema.optional(),
  read: z.enum(["paged", "findAll"]),
  pagination: z.object({
    pageField: z.string().min(1),
    pageNumberField: z.string().min(1),
    pageSizeField: z.string().min(1),
    startPage: z.number().int().nonnegative(),
    rowsField: z.string().min(1),
    pageSize: z.literal(EADP_PAGE_SIZE),
    totalSemantics: z.literal("pages")
  }).strict().optional(),
  identityFields: z.array(z.string().min(1)),
  compareFields: z.array(z.string().min(1)),
  writableFields: z.array(z.string().min(1)),
  sensitiveFields: z.array(z.string().min(1)).optional(),
  tenant: z.object({
    policy: z.enum(["any", "global", "non-global"]),
    bindField: z.string().min(1).optional()
  }).strict(),
  capabilities: z.array(z.enum(["query", "write", "compare", "sync"])).min(1),
  help: z.string().min(1),
  defaults: z.object({
    create: z.record(z.string(), z.unknown()).optional(),
    preserveTargetFields: z.array(z.string().min(1)).optional(),
    preserveTargetFieldsWhenMissing: z.array(z.string().min(1)).optional()
  }).strict().optional(),
  filtering: z.object({
    time: z.boolean(),
    defaultTimeField: z.string().min(1).optional()
  }).strict().optional(),
  enums: z.record(
    z.string(),
    z.array(z.object({ value: z.string(), meaning: z.string().min(1) }).strict())
  ).optional(),
  rollback: rollbackSchema.optional(),
  dependencies: z.array(z.string().min(1)).optional(),
  deletion: deletionSchema.optional()
}).strict().superRefine((manifest, context) => {
  if (manifest.read === "paged" && !manifest.pagination) {
    context.addIssue({ code: "custom", message: "read=paged 时必须声明 pagination" });
  }
  if (manifest.read === "findAll" && manifest.pagination) {
    context.addIssue({ code: "custom", message: "read=findAll 时不得声明 pagination" });
  }
  const sensitive = new Set(manifest.sensitiveFields ?? []);
  if (manifest.capabilities.some((capability) => capability !== "query") && sensitive.size > 0) {
    context.addIssue({
      code: "custom",
      message: "外部契约包含敏感字段时只能声明 query；通用变更计划和操作日志不承载秘密字段"
    });
  }
  if (manifest.capabilities.includes("write") && manifest.identityFields.length === 0) {
    context.addIssue({ code: "custom", message: "write 能力必须声明业务唯一键" });
  }
});

export type ResourceContractManifest = z.infer<typeof manifestSchema>;

export function parseResourceContractManifest(value: unknown): ResourceContract {
  const parsed = manifestSchema.parse(value);
  const { schemaVersion: _schemaVersion, ...contract } = parsed;
  return contract as ResourceContract;
}
