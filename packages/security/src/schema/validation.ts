import AjvPkg, { type ErrorObject } from "ajv";

export type ValidationSuccess<T> = {
  ok: true;
  value: T;
};

export type ValidationFailure = {
  ok: false;
  errors: string[];
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export type JsonSchema = Record<string, unknown>;

export type SchemaValidator<T> = {
  validate(value: unknown): ValidationResult<T>;
};

const formatErrors = (errors: ErrorObject[] | null | undefined): string[] => {
  if (!errors || errors.length === 0) {
    return ["invalid schema value"];
  }
  return errors.map((error) => {
    const pointer = error.instancePath
      ? error.instancePath.replace(/^\//, "").replace(/\//g, ".")
      : "<root>";
    const message = error.message ?? "invalid";
    return `${pointer}: ${message}`;
  });
};

export function createSchemaValidator<T>(schema: JsonSchema): SchemaValidator<T> {
  const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
    allErrors: true,
    strict: false,
    removeAdditional: false,
  });
  const compiled = ajv.compile(schema);

  return {
    validate(value: unknown): ValidationResult<T> {
      const ok = compiled(value);
      if (ok) {
        return { ok: true, value: value as T };
      }
      return { ok: false, errors: formatErrors(compiled.errors) };
    },
  };
}
