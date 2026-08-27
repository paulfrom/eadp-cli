# DbInfoController: safe query-only example

This example is based on these source artifacts:

- `sei-eai-service/.../backconfig/controller/DbInfoController.java`
- `sei-eai-api/.../api/backconfig/DbInfoApi.java`
- `sei-eai-api/.../dto/backconfig/DbInfoDto.java`
- `sei-eai-service/.../backconfig/entity/DbInfo.java`
- `sei-eai-component/.../core/db/DbType.java`

## Evidence decision

| Contract decision | Evidence |
| --- | --- |
| `service: sei-eai` | `DbInfoApi` is a Feign API for service `sei-eai`. |
| `dbInfo/findByPage`, `POST`, paged | `DbInfoApi.PATH` is `dbInfo`; `DbInfoController.findByPage(Search)` implements the inherited page API. The shared page contract supplies `pageInfo.page`, `pageInfo.rows`, response `rows`, first page `1`, page size `500`, and page-count `total`. |
| `dbType` enum | `DbType` declares `MYSQL`, `POSTGRESQL`, `SQLITE`, `MS_SQL`, `CH_DB`, and `ORACLE`. |
| `dbPass` sensitive | `DbInfoDto` documents `dbPass` as password, and the controller maps it to/from entity `password`. It must be redacted and must not be printed as evidence or copied to another field. |
| query only | The examined files do not establish a business unique key or a complete safe rollback/restore contract. Inherited CRUD behavior does not fill those gaps. |
| `tenant.policy: any` | The examined entity does not implement the shared tenant contract and does not persist `tenantCode`; no controller/API tenant restriction is declared. CLI still applies its non-global default for `any`. |
| no time filter | No inspected query contract establishes a supported creation-time range filter. |

The specialized methods `getBaseName`, `testConfig`, `clearCache`, and `getTableInfoList` are operations on connection metadata, not the registered record-query endpoint. Do not expose them through an ordinary external resource contract.

## Generated contract

Use the maintained [DbInfo contract asset](../assets/db-info.resource.yaml). Write it to the user-requested absolute output when one is explicit; otherwise use the exact path returned by `eadp resource contract-path db-info`.

`tenant.policy: any` is the policy selected for this example contract; it does not establish a default for other resources. The presence of `tenantCode` in a DTO alone is not enough to reuse this policy elsewhere.

After saving the YAML to an absolute `.resource.yaml` path, run only:

```powershell
eadp resource validate D:\absolute\path\db-info.resource.yaml
```
