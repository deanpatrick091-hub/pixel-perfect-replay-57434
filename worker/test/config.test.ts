import { test } from "node:test";
import assert from "node:assert/strict";

test("metered trade safety: both a key and explicit opt-in are required", async () => {
  const originalKey = process.env.PUMPPORTAL_API_KEY;
  const originalFlag = process.env.ENABLE_TRADE_SUBSCRIPTIONS;
  try {
    let n = 0;
    for (const [key, flag, expected] of [["", "false", false], ["test-key", "false", false], ["", "true", false], ["test-key", "true", true]] as const) {
      process.env.PUMPPORTAL_API_KEY = key; process.env.ENABLE_TRADE_SUBSCRIPTIONS = flag;
      const { tradeSubsEnabled } = await import(`../src/config.ts?trade-safety=${n++}`);
      assert.equal(tradeSubsEnabled(), expected);
    }
  } finally {
    if (originalKey == null) delete process.env.PUMPPORTAL_API_KEY; else process.env.PUMPPORTAL_API_KEY = originalKey;
    if (originalFlag == null) delete process.env.ENABLE_TRADE_SUBSCRIPTIONS; else process.env.ENABLE_TRADE_SUBSCRIPTIONS = originalFlag;
  }
});
