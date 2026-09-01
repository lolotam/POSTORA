// Which surfaces the AI agent setup page is showing, and how that survives a
// hop through a platform that has none of them.
//
// The `surface` query parameter is the user's PREFERENCE. What is shown is that
// preference intersected with what the platform can do: WhatsApp has no public
// comments, so it always shows DMs whatever the preference says.
//
// Keeping those two ideas apart is the whole point. Until this module existed,
// switching to WhatsApp rewrote the parameter itself to "dms" -- so choosing
// Comments on Facebook, glancing at WhatsApp and coming back showed Comments
// off, and the preference was gone rather than merely inapplicable.

export type AgentSurfaceSelection = "dms" | "comments" | "both";

export interface AgentSurfaceState {
  dmsActive: boolean;
  commentsActive: boolean;
  /** What to hand the child, always a surface the platform can actually serve. */
  surface: AgentSurfaceSelection;
}

/**
 * @param preference the raw `surface` query parameter, or null when unset
 * @param supportsComments whether the selected platform has public comments
 */
export function resolveAgentSurface(
  preference: string | null,
  supportsComments: boolean,
): AgentSurfaceState {
  let dmsActive: boolean;
  let commentsActive: boolean;

  if (preference === "dms") {
    dmsActive = true;
    commentsActive = false;
  } else if (preference === "comments" && supportsComments) {
    dmsActive = false;
    commentsActive = true;
  } else if (preference === "both" && supportsComments) {
    dmsActive = true;
    commentsActive = true;
  } else {
    // Unset, or a comments-only preference on a platform without comments.
    // DMs are shown so the page is never left with nothing selected.
    dmsActive = true;
    commentsActive = supportsComments;
  }

  return {
    dmsActive,
    commentsActive,
    surface: dmsActive && commentsActive ? "both" : dmsActive ? "dms" : "comments",
  };
}
