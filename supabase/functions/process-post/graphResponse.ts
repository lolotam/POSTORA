/** Graph API replies as process-post reads them. */

/** Meta's error object on a failed Graph API call. */
export interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
}

/** A Graph API reply: the created object's id, or Meta's error. Other fields vary by endpoint. */
export interface GraphResponse {
  id?: string;
  error?: GraphError;
  [field: string]: unknown;
}

/** The id Meta gave the created object. A reply with neither an error nor an id is an error too. */
export function graphId(reply: GraphResponse, what: string): string {
  if (typeof reply.id === "string" && reply.id) return reply.id;
  throw new Error(`${what}: Meta returned no id`);
}
