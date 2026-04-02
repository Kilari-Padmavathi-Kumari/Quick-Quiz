export const contestChannel = (contestId: string) => `contest:${contestId}`;
export const contestRoom = (contestId: string) => `contest:${contestId}`;
export const contestStateKey = (contestId: string) => `contest:${contestId}:state`;
export const contestMembersKey = (contestId: string) => `contest:${contestId}:members`;
export const contestScoresKey = (contestId: string) => `contest:${contestId}:scores`;
export const contestAnsweredKey = (contestId: string, seq: number) =>
  `contest:${contestId}:answered:${seq}`;
export const contestQuestionKey = (contestId: string, seq: number) =>
  `contest:${contestId}:question:${seq}`;
export const walletRequestsChannel = () => "wallet:requests";
