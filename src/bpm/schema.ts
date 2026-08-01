export interface BpmBusinessModuleDefinition {
  code: string;
  name: string;
  serviceName: string;
  webBaseAddress?: string;
}

export interface BpmBusinessEntityDefinition {
  name: string;
  code: string;
  serviceName: string;
  pcLookUrl?: string;
}

export interface BpmInterfaceDefinition {
  name: string;
  url: string;
  interfaceType: "EVENT";
}

export interface BpmPageDefinition {
  name: string;
  pcUrl: string;
}

export interface BpmFlowDefinition {
  name: string;
  code: string;
  entity: BpmBusinessEntityDefinition;
  interfaces: BpmInterfaceDefinition[];
  pages: BpmPageDefinition[];
}

export interface BpmProjectDefinition {
  projectPath: string;
  sourcePath: string;
  businessModule: BpmBusinessModuleDefinition;
  flows: BpmFlowDefinition[];
}

export interface BpmConfigureResult {
  environment: string;
  projectPath: string;
  sourcePath: string;
  applied: boolean;
  businessModule: ResourceResult;
  flows: BpmFlowResult[];
}

export interface ResourceResult {
  action: "created" | "reused" | "planned";
  id: string;
  name: string;
}

export interface BpmFlowResult {
  flow: string;
  entity: ResourceResult;
  pages: ResourceResult[];
  interfaces: ResourceResult[];
  pageRelationsAdded: number;
  interfaceRelationsAdded: number;
  flowType: ResourceResult;
  verified: boolean;
}
