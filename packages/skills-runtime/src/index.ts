export type SkillManifest = {
  id: string;
  name: string;
  version: string;
  entry: string;
  capabilities: string[];
  permissions?: {
    allowDomains?: string[];
    writePaths?: string[];
  };
};

export const SKILL_MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "version", "entry", "capabilities"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    entry: { type: "string", minLength: 1 },
    capabilities: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowDomains: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        writePaths: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
