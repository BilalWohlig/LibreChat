const { logger } = require('~/config');

const activeGenerations = new Map();

const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Register a new background generation.
 * @param {string} responseMessageId
 * @param {object} data
 */
function register(responseMessageId, data) {
  activeGenerations.set(responseMessageId, {
    ...data,
    responseMessageId,
    status: 'generating',
    startedAt: new Date(),
    lastUpdatedAt: new Date(),
  });
  logger.info(`[BackgroundGeneration] Registered: ${responseMessageId}`);
}

/**
 * Update the accumulated text for a background generation.
 * @param {string} responseMessageId
 * @param {string} text
 */
function update(responseMessageId, text) {
  const entry = activeGenerations.get(responseMessageId);
  if (entry) {
    entry.text = text;
    entry.lastUpdatedAt = new Date();
  }
}

/**
 * Mark a background generation as completed.
 * @param {string} responseMessageId
 */
function complete(responseMessageId) {
  const entry = activeGenerations.get(responseMessageId);
  if (entry) {
    entry.status = 'completed';
    entry.lastUpdatedAt = new Date();
    logger.info(`[BackgroundGeneration] Completed: ${responseMessageId}`);
  }
}

/**
 * Mark a background generation as failed.
 * @param {string} responseMessageId
 * @param {string} error
 */
function fail(responseMessageId, error) {
  const entry = activeGenerations.get(responseMessageId);
  if (entry) {
    entry.status = 'error';
    entry.error = error;
    entry.lastUpdatedAt = new Date();
    logger.error(`[BackgroundGeneration] Failed: ${responseMessageId} - ${error}`);
  }
}

/**
 * Get a background generation by responseMessageId.
 * @param {string} responseMessageId
 * @returns {object|undefined}
 */
function get(responseMessageId) {
  return activeGenerations.get(responseMessageId);
}

/**
 * Check if a background generation is active for a given responseMessageId.
 * @param {string} responseMessageId
 * @returns {boolean}
 */
function has(responseMessageId) {
  return activeGenerations.has(responseMessageId);
}

/**
 * Remove stale entries older than MAX_AGE_MS.
 */
function cleanup() {
  const now = Date.now();
  for (const [id, entry] of activeGenerations) {
    const age = now - new Date(entry.startedAt).getTime();
    if (age > MAX_AGE_MS) {
      activeGenerations.delete(id);
      logger.debug(`[BackgroundGeneration] Cleaned up stale entry: ${id}`);
    }
  }
}

// Run cleanup periodically
const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
// Allow the process to exit without waiting for the timer
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

module.exports = {
  register,
  update,
  complete,
  fail,
  get,
  has,
  cleanup,
};
