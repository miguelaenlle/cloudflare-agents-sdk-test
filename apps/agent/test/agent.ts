import { Chat as ProductionChat } from "../agent.ts";
import worker from "../agent.ts";
import type { CodexSandbox } from "../codex.ts";
import { TestSandbox } from "./sandbox.ts";
export { TestSandbox };

export class Chat extends ProductionChat {
  private fixture() {
    const env = this.env as typeof this.env & {
      TestSandbox: DurableObjectNamespace<TestSandbox>;
    };
    return env.TestSandbox.get(env.TestSandbox.idFromName(this.name));
  }
  protected override sandbox() {
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
    if (path.endsWith("/test/expire")) {
      await this.expireRun({ id: this.state.run!.id });
      return Response.json(this.state);
    }
    if (path.endsWith("/test/orphan-deadline")) {
      this.setState({
        ...this.state,
        run: {
          id: crypto.randomUUID(),
          messageId: "orphan",
          startedAt: Date.now(),
          status: "running",
        },
      });
      await this.expireRun({ id: this.state.run!.id });
      return Response.json({ state: this.state, messages: this.messages });
    }
    if (path.endsWith("/test/sleep")) {
      await this.fixture().sleep();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/fail-backup")) {
      await this.fixture().failNextBackup();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/ignore-cancel")) {
      await this.fixture().ignoreCancellation();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/test/state")) return Response.json(this.state);
    if (path.endsWith("/test/status"))
      return Response.json(await this.fixture().inspect());
    return super.onRequest(request);
  }
}
export default worker;
