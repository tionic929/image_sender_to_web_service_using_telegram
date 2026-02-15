import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    const total = await redis.llen('media_history');
    return res.status(200).json({ totalFiles: total });
  } catch (e) {
    return res.status(200).json({ totalFiles: 0 });
  }
}