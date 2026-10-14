// Dedicated single scheduler. Never log response bodies or authorization values.
const jobs = [
  { name: "refresh-tokens", hour: 5 },
  { name: "attach-next-reel", hour: 6 },
];
const lastRun = new Map();
let running = false;
if (!process.env.CRON_SECRET) throw new Error("CRON_SECRET is required");

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    for (const job of jobs) {
      if (now.getUTCHours() < job.hour || lastRun.get(job.name) === day) continue;
      try {
        const response = await fetch(`http://web:3000/api/cron/${job.name}`, {
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        lastRun.set(job.name, day);
        console.log(`[cron] ${job.name} completed`);
      } catch {
        console.error(`[cron] ${job.name} failed; retrying next minute`);
      }
    }
  } finally {
    running = false;
  }
}
void tick();
setInterval(() => void tick(), 60_000);
