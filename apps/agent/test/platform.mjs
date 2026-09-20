import { registerHooks } from "node:module";

// The real Sandbox SSE parser is portable, but its package also imports Worker
// classes. Unit tests must never instantiate those; integration tests use workerd.
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
