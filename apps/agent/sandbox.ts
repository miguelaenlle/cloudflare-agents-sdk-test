import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { forwardOpenAI } from "./outbound.ts";

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
    this.allowedHosts = ["openai.internal"];
    if (env.LOCAL_DEV === "true") return;
    // The SDK uploads/downloads backups from the container with presigned R2 URLs.
    const backupOrigin =
      env.BACKUP_BUCKET_ENDPOINT ??
      `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.allowedHosts.push(new URL(backupOrigin).hostname);
  }
}

Sandbox.outboundByHost = {
  "openai.internal": (request, env: { CODEX_API_KEY: string }) =>
    forwardOpenAI(request, env),
};
