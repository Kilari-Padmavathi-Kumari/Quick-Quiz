const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertOrganizationId(organizationId: string) {
  const trimmed = organizationId.trim();

  if (!UUID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid organization id for Redis scope: ${organizationId}`);
  }

  return trimmed;
}

function tenantPrefix(organizationId: string) {
  return `org:${assertOrganizationId(organizationId)}`;
}

export const contestChannel = (organizationId: string, contestId: string) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}`;
export const contestRoom = (organizationId: string, contestId: string) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}`;
export const contestStateKey = (organizationId: string, contestId: string) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}:state`;
export const contestMembersKey = (organizationId: string, contestId: string) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}:members`;
export const contestScoresKey = (organizationId: string, contestId: string) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}:scores`;
export const contestAnsweredKey = (organizationId: string, contestId: string, seq: number) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}:answered:${seq}`;
export const contestQuestionKey = (organizationId: string, contestId: string, seq: number) =>
  `${tenantPrefix(organizationId)}:contest:${contestId}:question:${seq}`;
export const walletRequestsChannel = (organizationId: string) =>
  `${tenantPrefix(organizationId)}:wallet:requests`;
