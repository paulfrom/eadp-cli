import type { OperationAction } from "../../operations/store.js";

export type NewOperationAction = OperationAction extends infer Action
  ? Action extends OperationAction
    ? Omit<Action, "id" | "status">
    : never
  : never;

export interface CommonOptions {
  env?: string;
  compact?: boolean;
}

export interface InspectOptions extends CommonOptions {
  app?: string;
  role?: string;
}

export interface ApplyRoleOptions extends CommonOptions {
  roleCode: string;
  roleName: string;
  group: string;
  roleType: string;
  ignoreParent?: boolean;
  apply?: boolean;
}

export interface AssignFeatureOptions extends CommonOptions {
  role: string;
  feature: string[];
  apply?: boolean;
}

export interface ApplyDataRoleOptions extends CommonOptions {
  roleCode: string;
  roleName: string;
  group: string;
  ignoreParent?: boolean;
  apply?: boolean;
}

export interface AssignDataOptions extends CommonOptions {
  role: string;
  authType: string;
  entity: string[];
  parentEntityId?: string;
  apply?: boolean;
}

export interface AssignPrincipalOptions extends CommonOptions {
  subjectType: "user" | "position" | "position-category";
  subject?: string;
  employeeCode?: string;
  employeeName?: string;
  roleType: "functional" | "data";
  role: string[];
  apply?: boolean;
}

export interface AssignPermissionOptions extends CommonOptions {
  sourceEmployeeCode?: string;
  sourceEmployeeName?: string;
  targetEmployeeCode?: string;
  targetEmployeeName?: string;
  apply?: boolean;
}

export interface VerifyOptions extends CommonOptions {
  user?: string;
  userId?: string;
  employeeCode?: string;
  employeeName?: string;
  feature: string[];
  menu: string[];
  entityClass?: string;
  dataFeature?: string;
  parentEntityId?: string;
}

export interface FeatureUsersOptions extends CommonOptions {
  feature: string;
}

export interface ApplyFeatureOptions extends CommonOptions {
  code: string;
  name: string;
  app: string;
  featureType: "Operate" | "Business" | "Page";
  group?: string;
  url?: string;
  canMenu?: boolean;
  tenantCanUse?: boolean;
  mobileUse?: boolean;
  apply?: boolean;
}

export interface ApplyFeatureGroupOptions extends CommonOptions {
  code: string;
  name: string;
  appCode: string;
  project?: string;
  rank: number;
  apply?: boolean;
}
