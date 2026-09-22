import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { forwardOpenAI } from "./outbound.ts";

export class Sandbox extends CloudflareSandbox {
  enableInternet = false;
  allowedHosts: string[];

  constructor(
    ctx: DurableObjectState<{}>,
    env: { CLOUDFLARE_ACCOUNT_ID: string; BACKUP_BUCKET_ENDPOINT?: string },
  ) {
    super(ctx, env);
    // The SDK uploads/downloads backups from the container with presigned R2 URLs.
    const backupOrigin =
      env.BACKUP_BUCKET_ENDPOINT ??
      `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.allowedHosts = ["api.openai.com", new URL(backupOrigin).hostname];
  }
}

Sandbox.outboundByHost = {
  "api.openai.com": (request, env: { CODEX_API_KEY: string }) =>
    forwardOpenAI(request, env),
};
