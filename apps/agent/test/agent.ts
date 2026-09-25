import { Chat as ProductionChat } from "../agent.ts";
import worker from "../worker.ts";
import { type CodexSandbox } from "../codex.ts";
import { TestSandbox } from "./sandbox.ts";
export { TestSandbox };

export class Chat extends ProductionChat {
  private fixture() {
    const env = this.env as typeof this.env & {
      TestSandbox: DurableObjectNamespace<TestSandbox>;
    };
    return env.TestSandbox.get(env.TestSandbox.idFromName(this.name));
  }
  protected override sandbox(_id: string) {
    const fixture = this.fixture();
    return new Proxy(fixture, {
      get(target, key) {
        if (key === "wsConnect")
          return (request: Request) => target.fetch(request);
        if (key === "startProcess")
          return async (command: string, options: { processId: string }) => {
            await target.startProcess(command, options);
            return { waitForPort: async () => {} };
          };
        return Reflect.get(target, key);
      },
    }) as unknown as CodexSandbox;
  }

  override async onRequest(request: Request) {
    if (new URL(request.url).pathname.endsWith("/test/status"))
      return Response.json(await this.fixture().inspect());
    return super.onRequest(request);
  }
}
export default worker;
