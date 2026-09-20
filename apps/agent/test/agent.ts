import { Chat as ProductionChat } from "../agent.ts";
import worker from "../agent.ts";
import {
  SANDBOX_IDLE_MS,
  SANDBOX_LIFETIME_MS,
  type CodexSandbox,
} from "../codex.ts";
import { TestSandbox } from "./sandbox.ts";
export { TestSandbox };

export class Chat extends ProductionChat {
  private timeOffset = 0;
  protected override now() {
    return Date.now() + this.timeOffset;
  }
  private fixture() {
    const env = this.env as typeof this.env & {
      TestSandbox: DurableObjectNamespace<TestSandbox>;
    };
    return env.TestSandbox.get(env.TestSandbox.idFromName(this.name));
  }
  protected override sandbox(_id: string) {
    return this.fixture() as unknown as CodexSandbox;
  }
  override async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/test/run")) {
      await this.persistMessages([
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Run fixture." }],
        },
      ]);
      const response = await this.onChatMessage(() => {});
      await response.text();
      return Response.json(this.state);
    }
    if (path.endsWith("/test/advance")) {
      const { milliseconds } = await request.json<{ milliseconds: number }>();
      this.timeOffset += milliseconds;
      // Invoke the actual persisted callbacks with a test clock, not six hours of sleep.
      for (const schedule of this.getSchedules<
        Parameters<Chat["expireSandbox"]>[0]
      >()) {
        if (
          schedule.callback === "expireSandbox" &&
          schedule.time * 1000 <= this.now()
        ) {
          await this.cancelSchedule(schedule.id);
          await this.expireSandbox(schedule.payload);
        }
      }
      return Response.json(this.state);
    }
    if (path.endsWith("/test/expire")) {
      const lifecycle = this.state.sandbox!;
      this.timeOffset = lifecycle.createdAt + SANDBOX_LIFETIME_MS - Date.now();
      for (const schedule of this.getSchedules<{
        id: string;
        reason: string;
      }>()) {
        if (
          schedule.payload.id === lifecycle.id &&
          schedule.payload.reason === "lifetime"
        )
          await this.cancelSchedule(schedule.id);
      }
      await this.expireSandbox({ id: lifecycle.id, reason: "lifetime" });
      return Response.json(this.state);
    }
    if (path.endsWith("/test/stale-idle")) {
      await this.expireSandbox({
        id: this.state.sandbox!.id,
        reason: "idle",
        waitingSince: this.now() - SANDBOX_IDLE_MS,
      });
      return Response.json(this.state);
    }
    if (path.endsWith("/test/expire-old")) {
      const { id } = await request.json<{ id: string }>();
      await this.expireSandbox({ id, reason: "lifetime" });
      return Response.json(this.state);
    }
    if (path.endsWith("/test/sleep")) {
      await this.fixture().sleep();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/fail-backup")) {
      await this.fixture().failNextBackup();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/fail-destroy")) {
      const { attempts } = await request.json<{ attempts: number }>();
      await this.fixture().failDestroy(attempts);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/ignore-cancel")) {
      await this.fixture().ignoreCancellation();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/schedules"))
      return Response.json(this.getSchedules());
    if (path.endsWith("/test/state")) return Response.json(this.state);
    if (path.endsWith("/test/status"))
      return Response.json(await this.fixture().inspect());
    return super.onRequest(request);
  }
}
export default worker;
