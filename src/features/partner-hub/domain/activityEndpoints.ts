/** Ledger `action` → the documented /v1 route (partner-api/v1/router.ts). */
const ACTION_ENDPOINTS: Record<string, string> = {
  list_accounts: "GET /v1/accounts",
  get_account: "GET /v1/accounts/{id}",
  list_conversations: "GET /v1/conversations",
  get_conversation: "GET /v1/conversations/{id}",
  list_conversation_messages: "GET /v1/conversations/{id}/messages",
  get_message: "GET /v1/messages/{id}",
  send_template: "POST /v1/messages",
  send_text: "POST /v1/messages",
  send_media: "POST /v1/messages",
  list_templates: "GET /v1/templates",
  upload_media: "POST /v1/media",
  get_media: "GET /v1/media/{id}",
  list_webhooks: "GET /v1/webhooks",
  get_webhook: "GET /v1/webhooks/{id}",
  create_webhook: "POST /v1/webhooks",
  update_webhook: "PATCH /v1/webhooks/{id}",
  delete_webhook: "DELETE /v1/webhooks/{id}",
  rotate_webhook_secret: "POST /v1/webhooks/{id}/rotate-secret",
  test_webhook: "POST /v1/webhooks/{id}/test",
  create_post: "POST /v1/posts",
  get_post: "GET /v1/posts/{id}",
  get_post_status: "GET /v1/posts/{id}/status",
  schedule_post: "POST /v1/posts/{id}/schedule",
  unschedule_post: "DELETE /v1/posts/{id}/schedule",
  get_usage: "GET /v1/usage",
};

export function endpointForAction(action: string): string {
  // Object.hasOwn is ES2022; this repo's lib is ES2020, and this is its exact
  // semantic equivalent (own-property check, no inherited `in` matches).
  return Object.prototype.hasOwnProperty.call(ACTION_ENDPOINTS, action) ? ACTION_ENDPOINTS[action] : action;
}
