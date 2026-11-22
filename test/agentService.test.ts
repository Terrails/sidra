// src/agent/service.ts: finding the agent's bin/amd, what the page is told when there is
// none, the AM_PORT / AM_STOREFRONT checks, and starting the service (one child at a time,
// a failed start shown to the page). The settings are read when the module loads, so every
// test loads a fresh copy after setting the environment.
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, default: { ...actual, spawn: spawnMock }, spawn: spawnMock };
});

const ENV_KEYS = [
  "AM_AGENT_DIR",
  "AM_PORT",
  "AM_PREFIX",
  "AM_STOREFRONT",
  "AM_WEBUI_NO_SPAWN",
  "PATH",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidra-agent-service-"));

function file(rel: string, mode: number): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n");
  fs.chmodSync(p, mode);
  return p;
}

/** A checkout of the agent: bin/amd (executable) with bin/amd-env.sh next to it. */
function checkout(rel: string): string {
  file(`${rel}/bin/amd`, 0o755);
  file(`${rel}/bin/amd-env.sh`, 0o644);
  return path.join(tmp, rel);
}

const agentDir = checkout("with space/agent");
checkout("linked");
file("noexec/bin/amd", 0o644);
file("noexec/bin/amd-env.sh", 0o644);
file("noenv/bin/amd", 0o755); // an unrelated `amd`, e.g. the automounter
fs.mkdirSync(path.join(tmp, "dirtarget", "bin", "amd"), { recursive: true });
file("dirtarget/bin/amd-env.sh", 0o644);
file("path-noexec/amd", 0o644);
file("path-other/amd", 0o755);
fs.mkdirSync(path.join(tmp, "path-link"));
fs.symlinkSync(
  path.join(tmp, "linked", "bin", "amd"),
  path.join(tmp, "path-link", "amd"),
);
const logsDir = path.join(tmp, "logs");

async function load() {
  vi.resetModules();
  const service = await import("../src/agent/service");
  const { app } = await import("electron");
  vi.spyOn(app, "getPath").mockReturnValue(logsDir);
  const { default: log } = await import("electron-log/main");
  const logged = (): string =>
    vi
      .mocked(log.scope("agent").error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
  return { service, logged };
}

beforeEach(() => {
  for (const k of ENV_KEYS) if (k !== "PATH") delete process.env[k];
  process.env.PATH = "";
  spawnMock.mockReset();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("findAgent", () => {
  it("takes $AM_AGENT_DIR/bin/amd (a path with spaces)", async () => {
    process.env.AM_AGENT_DIR = agentDir;
    const { service } = await load();
    expect(service.findAgent()).toBe(path.join(agentDir, "bin", "amd"));
  });

  it("refuses a bin/amd that is not executable or not a file", async () => {
    process.env.AM_AGENT_DIR = path.join(tmp, "noexec");
    expect((await load()).service.findAgent()).toBeNull();
    process.env.AM_AGENT_DIR = path.join(tmp, "dirtarget");
    expect((await load()).service.findAgent()).toBeNull();
  });

  it("refuses a bin/amd without amd-env.sh next to it", async () => {
    process.env.AM_AGENT_DIR = path.join(tmp, "noenv");
    expect((await load()).service.findAgent()).toBeNull();
  });

  it("does not fall back to PATH when AM_AGENT_DIR is wrong", async () => {
    process.env.AM_AGENT_DIR = path.join(tmp, "missing");
    process.env.PATH = path.join(tmp, "with space", "agent", "bin");
    expect((await load()).service.findAgent()).toBeNull();
  });

  it("uses PATH when AM_AGENT_DIR is unset or empty, skipping empty entries", async () => {
    process.env.AM_AGENT_DIR = "";
    process.env.PATH = `::${path.join(agentDir, "bin")}:`;
    expect((await load()).service.findAgent()).toBe(
      path.join(agentDir, "bin", "amd"),
    );
  });

  it("skips an `amd` on PATH that is not executable or not the agent's", async () => {
    process.env.PATH = [
      path.join(tmp, "path-noexec"),
      path.join(tmp, "path-other"),
      path.join(tmp, "path-link"),
    ].join(path.delimiter);
    const { service } = await load();
    // a symlink to the agent's bin/amd counts: amd-env.sh is next to its target
    expect(service.findAgent()).toBe(path.join(tmp, "path-link", "amd"));
  });

  it("finds nothing on an empty PATH or with only unrelated `amd`s", async () => {
    expect((await load()).service.findAgent()).toBeNull();
    process.env.PATH = path.join(tmp, "path-other");
    expect((await load()).service.findAgent()).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("agentMissing", () => {
  it("names AM_AGENT_DIR and the repository but no path; the log gets the path", async () => {
    process.env.AM_AGENT_DIR = path.join(tmp, "noenv");
    const { service, logged } = await load();
    const text = service.agentMissing();
    expect(text).toContain("AM_AGENT_DIR");
    expect(text).toContain("wine-engine-for-apple-music");
    expect(text).not.toContain(tmp);
    expect(text).not.toContain(os.homedir());
    expect(service.startService()).toBe(false);
    expect(logged()).toContain(path.join(tmp, "noenv", "bin", "amd"));
    expect(logged()).toContain("amd-env.sh");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("says how to point Sidra at the agent when AM_AGENT_DIR is unset", async () => {
    process.env.PATH = path.join(tmp, "path-other");
    const { service, logged } = await load();
    expect(service.agentMissing()).toContain("set AM_AGENT_DIR");
    expect(service.agentMissing()).not.toContain(tmp);
    expect(service.startService()).toBe(false);
    expect(logged()).toContain(path.join(tmp, "path-other", "amd"));
  });

  it("logs the reason once, not on every poll", async () => {
    process.env.AM_AGENT_DIR = path.join(tmp, "missing");
    const { service, logged } = await load();
    service.startService();
    service.startService();
    expect(logged().split("\n")).toHaveLength(1);
  });
});

describe("settings", () => {
  it.each([
    [undefined, 7654],
    ["7699", 7699],
    ["1", 1],
    ["65535", 65535],
    ["0", 7654],
    ["70000", 7654],
    ["80x", 7654],
    ["-1", 7654],
  ])("AM_PORT=%s -> %i", async (raw, port) => {
    if (raw !== undefined) process.env.AM_PORT = raw;
    expect((await load()).service.PORT).toBe(port);
  });

  it.each([
    [undefined, "us"],
    ["gb", "gb"],
    ["GB", "gb"],
    ["usa", "us"],
    ["g1", "us"],
  ])("AM_STOREFRONT=%s -> %s", async (raw, storefront) => {
    if (raw !== undefined) process.env.AM_STOREFRONT = raw;
    expect((await load()).service.STOREFRONT).toBe(storefront);
  });
});

/** A stand-in ChildProcess: exit() ends it. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    unref: vi.fn(),
    exit(code: number | null, signal: string | null = null) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    },
  });
  return child;
}

describe.skipIf(process.platform === "win32")("startService", () => {
  beforeEach(() => {
    process.env.AM_AGENT_DIR = agentDir;
    process.env.AM_STOREFRONT = "GB";
  });

  it("does nothing with AM_WEBUI_NO_SPAWN", async () => {
    process.env.AM_WEBUI_NO_SPAWN = "1";
    const { service } = await load();
    expect(service.startService()).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("starts bin/amd once while it runs, with the environment passed through", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { service } = await load();
    expect(service.startService()).toBe(true);
    expect(service.startService()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; stdio: unknown[]; detached: boolean },
    ];
    expect(cmd).toBe(path.join(agentDir, "bin", "amd"));
    expect(args).toEqual(["7654"]);
    expect(opts.detached).toBe(true);
    expect(opts.env.AM_STOREFRONT).toBe("GB"); // the user's value, not Sidra's "gb"/"us"
    expect(opts.env.AM_PREFIX).toContain("wine-engine-for-apple-music");
    expect(typeof opts.stdio[1]).toBe("number"); // the start log
    expect(fs.existsSync(path.join(logsDir, "amd-start.log"))).toBe(true);
    expect(service.startFailure()).toBeNull();

    child.exit(0); // quit: the next poll may start it again at once
    spawnMock.mockReturnValue(fakeChild());
    service.startService();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("reports a failed start without a path, and retries 25 s later", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { service, logged } = await load();
    service.startService();
    child.exit(1);
    const failure = service.startFailure();
    expect(failure).toContain("code 1");
    expect(failure).not.toContain("/");
    expect(logged()).toContain(path.join(logsDir, "amd-start.log"));

    spawnMock.mockReturnValue(fakeChild());
    service.startService();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(25_000);
    service.startService();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(service.startFailure()).toBe(failure); // until the service answers
  });

  it("reports a spawn error without a path", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { service } = await load();
    service.startService();
    child.emit("error", new Error(`spawn ${agentDir}/bin/amd EACCES`));
    expect(service.startFailure()).toMatch(/could not be started/);
    expect(service.startFailure()).not.toContain(tmp);
  });

  it("does not count a stop by signal as a failed start", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { service } = await load();
    service.startService();
    child.exit(null, "SIGTERM");
    expect(service.startFailure()).toBeNull();
  });
});
