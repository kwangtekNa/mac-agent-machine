import { mkdir, realpath, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { FakeAdapter, type FakeAdapterOptions } from "../../src/agents/fake/index.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { git, initRepo, makeTmpHome, removeTmp } from "../helpers/tmp-home.js";

export const USER = userInfo().username;
export const H = { "x-mam-user": USER, "x-mam-protocol": "1" };

export interface Fixture {
  tmp: string;
  home: string;
  workspaceRoot: string;
  app: string;
  adapter: FakeAdapter;
  manager: SessionManager;
  cleanup(): Promise<void>;
}

/** 임시 홈 + work/app(git, 커밋 1개, 수정 1개, untracked 1개) + work/lib + work/.hidden. */
export async function makeFixture(adapterOpts: FakeAdapterOptions = {}): Promise<Fixture> {
  const tmp = await makeTmpHome("mam-host-");
  const home = await realpath(tmp);
  const workspaceRoot = join(home, "work");
  const app = join(workspaceRoot, "app");
  await initRepo(app);
  await writeFile(join(app, "index.ts"), "export const a = 1;\n");
  await git(app, "add", ".");
  await git(app, "commit", "-q", "-m", "init");
  await writeFile(join(app, "index.ts"), "export const a = 2;\n");
  await writeFile(join(app, "new.txt"), "new\n");
  await writeFile(join(app, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
  await mkdir(join(workspaceRoot, "lib"));
  await mkdir(join(workspaceRoot, ".hidden"));
  const adapter = new FakeAdapter(adapterOpts);
  const manager = await SessionManager.open({
    dataDir: join(home, ".mam"),
    adapters: { claude: adapter },
    logger: { info() {}, warn() {}, error() {} },
  });
  return {
    tmp,
    home,
    workspaceRoot,
    app,
    adapter,
    manager,
    cleanup: async () => {
      await manager.shutdown();
      await removeTmp(tmp);
    },
  };
}

export async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
