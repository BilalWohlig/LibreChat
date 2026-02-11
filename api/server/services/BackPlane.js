const Redis = require('ioredis');
const { logger } = require('~/config');

let publisher;
let subscriber;

/**
 * Initialize Redis subscriber.
 * Provide a callback that will be called
 * whenever an activity event is received from another instance.
 */
function initSubscriber(onMessage) {
  // Skip Redis initialization if USE_REDIS is false
  if (process.env.USE_REDIS === 'false') {
    logger.info('[BackPlane] Redis disabled via USE_REDIS=false');
    return;
  }

  const redisUrl = process.env.REDIS_URI || 'redis://localhost:6379';

  if (!subscriber) {
    subscriber = new Redis(redisUrl);

    subscriber.subscribe('user-activity', (err, count) => {
      if (err) {
        logger.error('[BackPlane] Failed to subscribe to user-activity:', err);
      } else {
        logger.info(`[BackPlane] Subscribed to user-activity channel (count=${count})`);
      }
    });

    subscriber.on('message', (channel, message) => {
      if (channel !== 'user-activity') return;
      try {
        const parsed = JSON.parse(message);
        logger.debug('[BackPlane] Received cross-instance activity:', parsed);
        onMessage?.(parsed);
      } catch (e) {
        logger.error('[BackPlane] Failed to parse message:', e);
      }
    });
  }

  if (!publisher) {
    publisher = new Redis(redisUrl);
  }
}

/**
 * Publish an activity to Redis so all instances can see it.
 */
async function publishActivity(activityData) {
  // Skip Redis publishing if USE_REDIS is false
  if (process.env.USE_REDIS === 'false') {
    return;
  }

  try {
    if (!publisher) {
      const redisUrl = process.env.REDIS_URI || 'redis://localhost:6379';
      publisher = new Redis(redisUrl);
    }
    await publisher.publish('user-activity', JSON.stringify(activityData));
    logger.debug('[BackPlane] Published activity to Redis');
  } catch (e) {
    logger.error('[BackPlane] Failed to publish activity:', e);
  }
}

module.exports = {
  initSubscriber,
  publishActivity,
};


