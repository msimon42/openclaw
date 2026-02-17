import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const DecisionOutcomeSchema = Type.String({ enum: ["allow", "deny"] });

export const ObsFilterSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    eventTypes: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 200 })),
    modelRefs: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 200 })),
    decisionOutcome: Type.Optional(DecisionOutcomeSchema),
    riskTiers: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 20 })),
    sinceTs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ObsSubscribeParamsSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    filters: Type.Optional(ObsFilterSchema),
    maxEventsPerSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  },
  { additionalProperties: false },
);

export const ObsUnsubscribeParamsSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
  },
  { additionalProperties: false },
);

export const ObsPingParamsSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
  },
  { additionalProperties: false },
);
