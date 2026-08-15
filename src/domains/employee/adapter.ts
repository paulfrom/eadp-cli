import type { ResourceRecord, ResourceClient } from "../../resource/core/client.js";
import type { ResourceAdapter } from "../../resource/core/engine.js";
import { DependencyResolutionError } from "../../resource/core/errors.js";
import { mappedRecordId, requiredMappedString } from "../shared.js";

const writableFields = [
  "code", "userName", "organizationId", "frozen", "email", "mobile", "gender", "idCard"
];

const organizationLookups = new WeakMap<
  ResourceClient,
  Map<string, Promise<ResourceRecord | null>>
>();

export const employeeAdapter: ResourceAdapter = {
  async toDesired(source, targetClient) {
    const code = requiredMappedString(
      source.code,
      "employee",
      "code",
      "企业员工缺少 code"
    );
    requiredMappedString(source.userName, "employee", "userName", "企业员工缺少 userName");
    const organizationCode = requiredMappedString(
      source.organizationCode,
      "employee",
      "organizationCode",
      "企业员工必须提供 organizationCode，不能使用源 organizationId 代替"
    );
    const organization = await findOrganization(targetClient, organizationCode);
    if (!organization) {
      throw new DependencyResolutionError([{
        resource: "organization",
        identityField: "code",
        value: organizationCode,
        reason: "missing"
      }]);
    }

    const desired: ResourceRecord = {};
    for (const field of writableFields) {
      if (field in source) desired[field] = source[field];
    }
    desired.code = code;
    desired.organizationId = mappedRecordId(organization, "organization", "目标环境组织机构");
    return desired;
  }
};

async function findOrganization(
  targetClient: ResourceClient,
  code: string
): Promise<ResourceRecord | null> {
  let cache = organizationLookups.get(targetClient);
  if (!cache) {
    cache = new Map<string, Promise<ResourceRecord | null>>();
    organizationLookups.set(targetClient, cache);
  }
  const lookup = cache.get(code);
  if (lookup) return lookup;
  const pending = targetClient.findByCode("organization", code);
  cache.set(code, pending);
  return pending;
}
