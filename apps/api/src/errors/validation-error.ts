import { ApiError } from "./api-error";
import {
  formatValidationIssues,
  type ValidationIssueInput,
} from "./validation-issues";

type ValidationResult = {
  success: boolean;
  target?: string;
  error?: { issues: readonly ValidationIssueInput[] };
};

export function validationError(
  issues: readonly ValidationIssueInput[],
  target?: string,
  message?: string,
) {
  const formatted = formatValidationIssues(issues, target);
  return new ApiError(400, {
    message: message ?? formatted.message,
    code: "VALIDATION_ERROR",
    issues: formatted.issues,
  });
}

export function validationHook(result: ValidationResult): undefined {
  if (result.success) return;
  throw validationError(result.error?.issues ?? [], result.target);
}

type StandardSchemaIssue = {
  message?: string;
  path?: readonly unknown[];
};

function issuePath(segment: unknown): PropertyKey {
  if (segment !== null && typeof segment === "object" && "key" in segment) {
    const key = (segment as { key?: PropertyKey }).key;
    return key ?? "";
  }
  return typeof segment === "string" || typeof segment === "number"
    ? segment
    : String(segment);
}

function standardSchemaIssues(error: unknown): readonly StandardSchemaIssue[] {
  if (Array.isArray(error)) return error as StandardSchemaIssue[];
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues as StandardSchemaIssue[];
  }
  return [];
}

/** hono-openapi's valibot validator reports Standard Schema issues. */
export function standardSchemaValidationHook(result: {
  success: boolean;
  target?: string;
  error?: unknown;
}): undefined {
  if (result.success) return;
  throw validationError(
    standardSchemaIssues(result.error).map((issue) => ({
      message: issue.message,
      path: issue.path?.map(issuePath),
    })),
    result.target,
  );
}

export function validationHookWithMessage(message: string) {
  return (result: ValidationResult): undefined => {
    if (result.success) return;
    throw validationError(result.error?.issues ?? [], result.target, message);
  };
}
