import type * as Main from "../../src/index.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof Main;
    }
    interface Env extends Main.Env {}
  }
}
