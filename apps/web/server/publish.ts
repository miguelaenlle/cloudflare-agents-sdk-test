import { GITHUB_REPOSITORY, type Approval } from "@playground/chat-contract";
export const EMPTY_BASE = "0".repeat(40);
export type Destination = { repository: string; branch: string };
export function destination(): Destination {
  return {
    repository: GITHUB_REPOSITORY,
    branch: process.env.PUSH_BRANCH ?? "main",
  };
}
export type Publication = {
  id: string;
  sequence: number;
  destination: Destination;
  approval: Approval;
  createdAt: string;
  candidate?: string;
};
