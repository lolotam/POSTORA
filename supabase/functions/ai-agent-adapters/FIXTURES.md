# Adapter fixture seam

Unit tests inject all network behavior through `AdapterDependencies.fetch` and URL validation
through `AdapterDependencies.assertPublicHttpsUrl`; they never use live network or credentials.

An explicit end-to-end fixture may later supply this shape to the deployed function:

```json
{
  "tool_id": "owned ai_agent_tools UUID",
  "action": "execute",
  "capability": "search_products",
  "parameters": { "query": "hat" }
}
```

`test_connection` uses the same fixture with `action: "test_connection"` and no capability.
Credentials are never fixture fields: the function retrieves the owned tool's Vault blob through
`get_connector_credential`. Any live verification must be an explicitly invoked external test with
a real bearer token and owned tool id; there is intentionally no environment-gated test that skips.

