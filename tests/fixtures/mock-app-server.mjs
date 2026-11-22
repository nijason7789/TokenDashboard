import { createInterface } from "node:readline";

const scenario = process.argv[2];
const input = createInterface({ input: process.stdin });
let stage = "new";
const write = (packet) => process.stdout.write(JSON.stringify(packet) + "\n");
const rateLimits = {
  limitId: "codex",
  primary: {
    usedPercent: 23,
    windowDurationMins: 300,
    resetsAt: 1_800_000_000,
  },
  secondary: {
    usedPercent: 30,
    windowDurationMins: 10080,
    resetsAt: 1_800_600_000,
  },
};

for await (const line of input) {
  const packet = JSON.parse(line);
  const respond = (result) => write({ id: packet.id, result });
  if (packet.method === "initialize" && stage === "new") {
    stage = "initializing";
    respond({
      userAgent: "fixture",
      codexHome: "C:\\fixture",
      platformFamily: "windows",
      platformOs: "windows",
    });
  } else if (packet.method === "initialized" && stage === "initializing") {
    stage = "ready";
  } else if (
    packet.method === "account/read" &&
    stage === "ready" &&
    packet.params.refreshToken === false
  ) {
    respond({
      account: {
        type: "chatgpt",
        email: null,
        workspaceName: null,
        planType: "plus",
      },
      userId: null,
      requiresOpenaiAuth: true,
    });
  } else if (
    packet.method === "account/rateLimits/read" &&
    stage === "ready" &&
    packet.params.excludeResetCreditDetails === true
  ) {
    if (scenario === "exit") process.exit(7);
    if (scenario === "malformed") {
      process.stdout.write("{broken\n");
      continue;
    }
    if (scenario === "stall") continue;
    respond({ rateLimits, rateLimitsByLimitId: { codex: rateLimits } });
    write({ method: "account/rateLimits/updated", params: { rateLimits } });
  } else {
    process.exit(2);
  }
}
