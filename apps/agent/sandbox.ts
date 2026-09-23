import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { forwardOpenAI, forwardGitHub } from "./outbound.ts";

export class Sandbox extends CloudflareSandbox {
  enableInternet = false;
  allowedHosts: string[];

  constructor(
    ctx: DurableObjectState<{}>,
    env: {
      CLOUDFLARE_ACCOUNT_ID: string;
      BACKUP_BUCKET_ENDPOINT?: string;
      LOCAL_DEV?: string;
    },
  ) {
    super(ctx, env);
    this.allowedHosts = ["openai.internal", "github.com"];
    if (env.LOCAL_DEV === "true") return;
    // The SDK uploads/downloads backups from the container with presigned R2 URLs.
    const backupOrigin =
      env.BACKUP_BUCKET_ENDPOINT ??
      `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.allowedHosts.push(new URL(backupOrigin).hostname);
  }
}

Sandbox.outboundByHost = {
  "github.com": (
    request,
    env: { GITHUB_REPOSITORY?: string; GITHUB_TOKEN?: string },
  ) => forwardGitHub(request, env),
  "openai.internal": (request, env: { CODEX_API_KEY: string }) =>
    forwardOpenAI(request, env),
};
