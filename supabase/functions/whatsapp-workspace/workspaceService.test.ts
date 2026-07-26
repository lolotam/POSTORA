import {
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type AuthenticatedCaller,
  canManageWorkspace,
  canReadWorkspace,
  createWorkspaceHandler,
  generateInvitationToken,
  InvitationAcceptanceError,
  type InvitationInsert,
  normalizeEmail,
  roleAtLeast,
  sha256Hex,
  type WorkspaceClient,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSummary,
  wouldDemoteLastOwner,
  wouldRemoveLastOwner,
} from "./workspaceService.ts";

const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const INVITATION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-07-26T12:00:00.000Z");
const RAW_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RAW_TOKEN_SHA256 =
  "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e";

interface FakeClientOptions {
  roles?: Record<string, WorkspaceRole | null>;
  targetMember?: WorkspaceMember;
  ownerCount?: number;
  invitationStates?: Record<
    string,
    "active" | "expired" | "revoked" | "accepted"
  >;
}

class FakeWorkspaceClient implements WorkspaceClient {
  readonly ensuredUserIds: string[] = [];
  readonly persistedInvitations: InvitationInsert[] = [];
  readonly changedRoles: Array<{ userId: string; role: WorkspaceRole }> = [];
  readonly removedUserIds: string[] = [];
  readonly roles: Record<string, WorkspaceRole | null>;
  readonly targetMember: WorkspaceMember;
  readonly ownerCount: number;
  readonly invitationStates: Record<
    string,
    "active" | "expired" | "revoked" | "accepted"
  >;
  alreadyMember = false;

  constructor(options: FakeClientOptions = {}) {
    this.roles = options.roles ?? { [WORKSPACE_ID]: "owner" };
    this.targetMember = options.targetMember ?? {
      id: "member-row-id",
      workspace_id: WORKSPACE_ID,
      user_id: MEMBER_ID,
      role: "agent",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    this.ownerCount = options.ownerCount ?? 2;
    this.invitationStates = options.invitationStates ?? {};
  }

  ensurePersonalWorkspace(userId: string): Promise<void> {
    this.ensuredUserIds.push(userId);
    return Promise.resolve();
  }

  listWorkspaces(_userId: string): Promise<WorkspaceSummary[]> {
    return Promise.resolve([{
      id: WORKSPACE_ID,
      name: "Acme Support",
      owner_id: CALLER_ID,
      is_personal: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      role: "owner",
      member_count: 2,
    }]);
  }

  workspaceRole(
    workspaceId: string,
    _userId: string,
  ): Promise<WorkspaceRole | null> {
    return Promise.resolve(this.roles[workspaceId] ?? null);
  }

  workspaceName(_workspaceId: string): Promise<string> {
    return Promise.resolve("Acme Support");
  }

  listMembers(_workspaceId: string): Promise<WorkspaceMember[]> {
    return Promise.resolve([this.targetMember]);
  }

  listPendingInvitations(
    _workspaceId: string,
    _nowIso: string,
  ): Promise<WorkspaceInvitation[]> {
    return Promise.resolve([]);
  }

  isEmailMember(_workspaceId: string, _email: string): Promise<boolean> {
    return Promise.resolve(this.alreadyMember);
  }

  createInvitation(invitation: InvitationInsert): Promise<WorkspaceInvitation> {
    this.persistedInvitations.push(invitation);
    return Promise.resolve({
      id: INVITATION_ID,
      ...invitation,
      accepted_at: null,
      accepted_by: null,
      revoked_at: null,
      created_at: NOW.toISOString(),
    });
  }

  revokeInvitation(
    _workspaceId: string,
    _invitationId: string,
    _revokedAt: string,
  ): Promise<boolean> {
    return Promise.resolve(true);
  }

  acceptInvitation(rawToken: string): Promise<string> {
    const invitationState = this.invitationStates[rawToken] ?? "active";
    if (invitationState !== "active") {
      return Promise.reject(
        new InvitationAcceptanceError("Invalid workspace invitation"),
      );
    }
    return Promise.resolve(WORKSPACE_ID);
  }

  member(
    _workspaceId: string,
    _userId: string,
  ): Promise<WorkspaceMember | null> {
    return Promise.resolve(this.targetMember);
  }

  countOwners(_workspaceId: string): Promise<number> {
    return Promise.resolve(this.ownerCount);
  }

  changeMemberRole(
    _workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember> {
    this.changedRoles.push({ userId, role });
    return Promise.resolve({ ...this.targetMember, role });
  }

  removeMember(_workspaceId: string, userId: string): Promise<void> {
    this.removedUserIds.push(userId);
    return Promise.resolve();
  }
}

function request(
  body: Record<string, unknown>,
  authorization = "Bearer valid-token",
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization) headers.set("Authorization", authorization);
  return new Request(
    "https://api.postora.cloud/functions/v1/whatsapp-workspace",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

function handlerFor(
  client: FakeWorkspaceClient,
  sentTokens: string[] = [],
) {
  return createWorkspaceHandler({
    authenticate: (req: Request): Promise<AuthenticatedCaller> => {
      if (req.headers.get("Authorization") !== "Bearer valid-token") {
        return Promise.reject(new Error("Unauthorized"));
      }
      return Promise.resolve({ userId: CALLER_ID, isServiceRole: false });
    },
    clientFor: () => client,
    sendInvitationEmail: (message) => {
      sentTokens.push(message.rawToken);
      return Promise.resolve();
    },
    generateToken: () => RAW_TOKEN,
    now: () => NOW,
  });
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test("authentication is required for missing and invalid bearer tokens", async () => {
  const handler = handlerFor(new FakeWorkspaceClient());
  const missing = await handler(request({ action: "list_workspaces" }, ""));
  const invalid = await handler(
    request({ action: "list_workspaces" }, "Bearer invalid-token"),
  );

  assertEquals(missing.status, 401);
  assertEquals(await responseJson(missing), { error: "Unauthorized" });
  assertEquals(invalid.status, 401);
  assertEquals(await responseJson(invalid), { error: "Unauthorized" });
});

Deno.test("workspace roles are ordered owner above admin above agent above viewer", () => {
  assertEquals(roleAtLeast("owner", "admin"), true);
  assertEquals(roleAtLeast("admin", "agent"), true);
  assertEquals(roleAtLeast("agent", "viewer"), true);
  assertEquals(roleAtLeast("viewer", "agent"), false);
  assertEquals(roleAtLeast("agent", "admin"), false);
  assertEquals(roleAtLeast("admin", "owner"), false);
});

Deno.test("permission decisions allow members to read and managers to mutate", () => {
  for (const role of ["owner", "admin", "agent", "viewer"] as WorkspaceRole[]) {
    assertEquals(canReadWorkspace(role), true, role);
  }
  assertEquals(canReadWorkspace(null), false);
  assertEquals(canManageWorkspace("owner"), true);
  assertEquals(canManageWorkspace("admin"), true);
  assertEquals(canManageWorkspace("agent"), false);
  assertEquals(canManageWorkspace("viewer"), false);
  assertEquals(canManageWorkspace(null), false);
});

Deno.test("email normalization lowercases and trims invitation addresses", () => {
  assertEquals(normalizeEmail("  Foo@Example.COM "), "foo@example.com");
});

Deno.test("invitation token generation uses 32 random bytes encoded as hex", () => {
  const first = generateInvitationToken();
  const second = generateInvitationToken();

  assertMatch(first, /^[0-9a-f]{64}$/);
  assertMatch(second, /^[0-9a-f]{64}$/);
  assertNotEquals(first, second);
});

Deno.test("SHA-256 hashing returns lowercase hexadecimal", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("invite persists only the token hash and never returns the raw token", async () => {
  const client = new FakeWorkspaceClient();
  const sentTokens: string[] = [];
  const response = await handlerFor(client, sentTokens)(request({
    action: "invite_member",
    workspace_id: WORKSPACE_ID,
    email: "  Foo@Example.COM ",
    role: "agent",
  }));
  const serializedBody = await response.text();
  const serializedPayload = JSON.stringify(client.persistedInvitations);

  assertEquals(response.status, 201);
  assertEquals(client.persistedInvitations.length, 1);
  assertEquals(client.persistedInvitations[0].token_hash, RAW_TOKEN_SHA256);
  assertEquals(client.persistedInvitations[0].email, "foo@example.com");
  assertEquals(serializedPayload.includes(RAW_TOKEN), false);
  assertEquals(serializedBody.includes(RAW_TOKEN), false);
  assertEquals(serializedBody.includes(RAW_TOKEN_SHA256), false);
  assertEquals(sentTokens, [RAW_TOKEN]);
});

Deno.test("expired revoked and replayed invitations share one generic rejection", async () => {
  const client = new FakeWorkspaceClient({
    invitationStates: {
      "expired-token": "expired",
      "revoked-token": "revoked",
      "replayed-token": "accepted",
    },
  });
  const handler = handlerFor(client);
  const rejectionBodies: Array<Record<string, unknown>> = [];

  for (const token of ["expired-token", "revoked-token", "replayed-token"]) {
    const response = await handler(
      request({ action: "accept_invitation", token }),
    );
    assertEquals(response.status, 400, token);
    rejectionBodies.push(await responseJson(response));
  }

  assertEquals(rejectionBodies, [
    { error: "Invalid workspace invitation" },
    { error: "Invalid workspace invitation" },
    { error: "Invalid workspace invitation" },
  ]);
});

Deno.test("non-member and nonexistent workspace rejections are identical", async () => {
  const client = new FakeWorkspaceClient({
    roles: { "non-member-workspace": null },
  });
  const handler = handlerFor(client);
  const nonMember = await handler(request({
    action: "list_members",
    workspace_id: "non-member-workspace",
  }));
  const nonexistent = await handler(request({
    action: "list_members",
    workspace_id: "nonexistent-workspace",
  }));
  const nonMemberBody = await nonMember.text();
  const nonexistentBody = await nonexistent.text();

  assertEquals(nonMember.status, nonexistent.status);
  assertEquals(nonMemberBody, nonexistentBody);
  assertEquals(nonMember.status, 404);
  assertEquals(JSON.parse(nonMemberBody), { error: "Workspace not found" });
});

Deno.test("the last owner cannot be demoted", async () => {
  const owner: WorkspaceMember = {
    id: "owner-row-id",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
    role: "owner",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const client = new FakeWorkspaceClient({
    targetMember: owner,
    ownerCount: 1,
  });
  const response = await handlerFor(client)(request({
    action: "change_member_role",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
    role: "admin",
  }));

  assertEquals(wouldDemoteLastOwner("owner", "admin", 1), true);
  assertEquals(response.status, 409);
  assertEquals(await responseJson(response), {
    error: "A workspace must retain at least one owner",
  });
  assertEquals(client.changedRoles, []);
});

Deno.test("the last owner cannot be removed", async () => {
  const owner: WorkspaceMember = {
    id: "owner-row-id",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
    role: "owner",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const client = new FakeWorkspaceClient({
    targetMember: owner,
    ownerCount: 1,
  });
  const response = await handlerFor(client)(request({
    action: "remove_member",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
  }));

  assertEquals(wouldRemoveLastOwner("owner", 1), true);
  assertEquals(response.status, 409);
  assertEquals(await responseJson(response), {
    error: "A workspace must retain at least one owner",
  });
  assertEquals(client.removedUserIds, []);
});

Deno.test("invite rejects the owner role before persisting", async () => {
  const client = new FakeWorkspaceClient();
  const response = await handlerFor(client)(request({
    action: "invite_member",
    workspace_id: WORKSPACE_ID,
    email: "owner@example.com",
    role: "owner",
  }));

  assertEquals(response.status, 400);
  assertEquals(await responseJson(response), {
    error: "Invitation role must be admin, agent, or viewer",
  });
  assertEquals(client.persistedInvitations, []);
});

Deno.test("invite rejects an email that already belongs to a member", async () => {
  const client = new FakeWorkspaceClient();
  client.alreadyMember = true;
  const response = await handlerFor(client)(request({
    action: "invite_member",
    workspace_id: WORKSPACE_ID,
    email: "member@example.com",
    role: "agent",
  }));

  assertEquals(response.status, 409);
  assertEquals(await responseJson(response), {
    error: "User is already a workspace member",
  });
  assertEquals(client.persistedInvitations, []);
});

Deno.test("list_workspaces creates the caller's personal workspace first", async () => {
  const client = new FakeWorkspaceClient();
  const response = await handlerFor(client)(
    request({ action: "list_workspaces" }),
  );

  assertEquals(response.status, 200);
  assertEquals(client.ensuredUserIds, [CALLER_ID]);
  assertEquals(await responseJson(response), {
    workspaces: [{
      id: WORKSPACE_ID,
      name: "Acme Support",
      owner_id: CALLER_ID,
      is_personal: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      role: "owner",
      member_count: 2,
    }],
  });
});

Deno.test("an ordinary member may leave when they are not the last owner", async () => {
  const self: WorkspaceMember = {
    id: "self-row-id",
    workspace_id: WORKSPACE_ID,
    user_id: CALLER_ID,
    role: "viewer",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "viewer" },
    targetMember: self,
  });
  const response = await handlerFor(client)(request({
    action: "remove_member",
    workspace_id: WORKSPACE_ID,
    user_id: CALLER_ID,
  }));

  assertEquals(response.status, 200);
  assertEquals(client.removedUserIds, [CALLER_ID]);
});

Deno.test("agents cannot remove another workspace member", async () => {
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "agent" },
  });
  const response = await handlerFor(client)(request({
    action: "remove_member",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
  }));

  assertEquals(response.status, 403);
  assertEquals(await responseJson(response), { error: "Forbidden" });
  assertEquals(client.removedUserIds, []);
});

// Ownership is gated separately from ordinary management. Without these rules an
// admin could promote itself to owner and then, because the workspace suddenly
// has two owners, remove the original owner — a complete takeover from an admin
// seat. Each half is harmless alone, so both are pinned here.
Deno.test("an admin cannot promote anyone to owner", async () => {
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "admin" },
  });
  const response = await handlerFor(client)(request({
    action: "change_member_role",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
    role: "owner",
  }));

  assertEquals(response.status, 403);
  assertEquals(await responseJson(response), { error: "Forbidden" });
  assertEquals(client.changedRoles, []);
});

Deno.test("an admin cannot promote itself to owner", async () => {
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "admin" },
    targetMember: {
      id: "caller-row-id",
      workspace_id: WORKSPACE_ID,
      user_id: CALLER_ID,
      role: "admin",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  });
  const response = await handlerFor(client)(request({
    action: "change_member_role",
    workspace_id: WORKSPACE_ID,
    user_id: CALLER_ID,
    role: "owner",
  }));

  assertEquals(response.status, 403);
  assertEquals(client.changedRoles, []);
});

Deno.test("an admin cannot demote an owner even when another owner remains", async () => {
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "admin" },
    ownerCount: 2,
    targetMember: {
      id: "owner-row-id",
      workspace_id: WORKSPACE_ID,
      user_id: MEMBER_ID,
      role: "owner",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  });
  const response = await handlerFor(client)(request({
    action: "change_member_role",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
    role: "viewer",
  }));

  assertEquals(response.status, 403);
  assertEquals(client.changedRoles, []);
});

Deno.test("an admin cannot remove an owner even when another owner remains", async () => {
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "admin" },
    ownerCount: 2,
    targetMember: {
      id: "owner-row-id",
      workspace_id: WORKSPACE_ID,
      user_id: MEMBER_ID,
      role: "owner",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  });
  const response = await handlerFor(client)(request({
    action: "remove_member",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
  }));

  assertEquals(response.status, 403);
  assertEquals(client.removedUserIds, []);
});

Deno.test("an owner may still grant ownership", async () => {
  const client = new FakeWorkspaceClient({
    roles: { [WORKSPACE_ID]: "owner" },
  });
  const response = await handlerFor(client)(request({
    action: "change_member_role",
    workspace_id: WORKSPACE_ID,
    user_id: MEMBER_ID,
    role: "owner",
  }));

  assertEquals(response.status, 200);
  assertEquals(client.changedRoles, [{ userId: MEMBER_ID, role: "owner" }]);
});
