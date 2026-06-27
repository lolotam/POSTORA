import { z } from "npm:zod@3.23.8";

export type ValidationSuccess<T> = { success: true; data: T };
export type ValidationFailure = {
  success: false;
  error: string;
  details: { field: string; message: string }[];
};
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validateRequestBody<T>(
  schema: z.ZodSchema<T>,
  body: unknown,
): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: "Invalid request body",
    details: result.error.issues.map((i) => ({
      field: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}

export function validationErrorResponse(
  result: ValidationFailure,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: result.error,
      details: result.details,
    }),
    {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
