import { listDecks } from "./lib/transport/hid-win.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  const decks = listDecks();
  if (decks.length > 0) {
    console.log(`FOUND after ${i * 2}s: ${decks[0].path}`);
    process.exit(0);
  }
  await wait(2000);
}
console.log("TIMEOUT: 120 秒内没有枚举到设备");
