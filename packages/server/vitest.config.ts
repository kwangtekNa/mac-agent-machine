import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** `npx vitest run --root packages/server <filter>` 용. 루트 설정과 같은 alias 를 쓴다. */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: { alias: { "@mam/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)) } },
});
