import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    console.log('Fetching media history...');

    // Fetch the list from Redis
    const history = await redis.lrange('media_history', 0, -1);
    
    if (!history || history.length === 0) {
      console.log('No media history found');
      // Set cache headers for empty responses
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate');
      return res.status(200).json([]);
    }

    // Parse Redis items back to objects
    const parsedHistory = history
      .map(item => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch (parseError) {
          console.error('Error parsing history item:', parseError.message);
          return null;
        }
      })
      .filter(item => item !== null); // Remove any corrupted entries

    console.log(`Returning ${parsedHistory.length} media items`);

    // Set cache headers for faster subsequent loads
    // Cache for 30 seconds on CDN, allow stale content while revalidating
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    
    return res.status(200).json(parsedHistory);

  } catch (error) {
    console.error('History handler error:', error.message);
    console.error('Stack:', error.stack);
    
    // Return empty array on error to prevent frontend crashes
    return res.status(200).json([]);
  }
}