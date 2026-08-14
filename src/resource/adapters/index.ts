import { createResourceAdapterRegistry } from "../core/engine.js";
import { featureAdapter } from "./feature.js";
import { featureGroupAdapter } from "./feature-group.js";
import { serialNumberAdapter } from "./serial-number.js";

export { featureAdapter } from "./feature.js";
export { featureGroupAdapter } from "./feature-group.js";
export { serialNumberAdapter } from "./serial-number.js";

export const resourceAdapterRegistry = createResourceAdapterRegistry([
  ["feature", featureAdapter],
  ["feature-group", featureGroupAdapter],
  ["serial-number", serialNumberAdapter]
]);
