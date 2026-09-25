import { registerHooks } from "node:module";

// Unit tests use portable helpers; Worker-only imports require workerd.
const platform = `
  const unavailable = () => { throw new Error("Use workerd for Sandbox runtime tests."); };
  export class Container { constructor() { unavailable(); } }
  export class ContainerProxy { constructor() { unavailable(); } }
  export class RpcTarget { constructor() { unavailable(); } }
  export const getContainer = unavailable;
  export const switchPort = unavailable;
  export const tracing = {};
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@cloudflare/containers" ||
      specifier === "cloudflare:workers"
    ) {
      return {
        url: `data:text/javascript,${encodeURIComponent(platform)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
