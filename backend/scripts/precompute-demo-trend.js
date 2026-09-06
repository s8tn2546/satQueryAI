import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../src/services/db.js';

dotenv.config();

import { precomputeDemoTrend } from '../src/services/demoTrendService.js';

async function main() {
  await connectDB();
  try {
    const report = await precomputeDemoTrend();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exit(1);
    }
  } finally {
    await disconnectDB();
  }
}

main().catch((err) => {
  console.error('[precompute-demo-trend] Failed:', err);
  process.exit(1);
});