/**
 * What to tell a person when a connection did not complete. The server answers
 * stable codes; a raw `channel_already_native` on screen was read on
 * 2026-09-03 as "it did not work" rather than "it is already connected".
 * Unknown codes stay visible so support can still be quoted one.
 */
export function connectionFailureMessage(code: string, label: string): string {
  switch (code) {
    case "channel_already_native":
      return `This YouTube channel is already connected through Direct Google OAuth. Disconnect it from its profile first to manage it through Composio.`;
    case "timeout":
    case "expired":
      return `The ${label} authorisation was not completed in time. Connect again to retry.`;
    case "superseded":
      return `A newer ${label} connection attempt replaced this one.`;
    case "request_failed":
      return `Postora could not check the ${label} connection. Reload the page and connect again.`;
    case "no_channel":
      return "The Google account you authorised has no YouTube channel.";
    case "tenancy_mismatch":
    case "connection_not_found":
    case "invalid_state":
      return `The ${label} authorisation did not match this workspace. Connect again.`;
    case "connector_unavailable":
      return `${label} could not be reached. Try again in a few minutes.`;
    default:
      return `The ${label} connection did not complete (${code}).`;
  }
}
