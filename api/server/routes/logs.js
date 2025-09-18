const express = require('express');
const router = express.Router();
const { requireJwtAuth, checkAdmin } = require('~/server/middleware');
const queryLogger = require('~/server/services/QueryLogger');
const { Message, User } = require('~/db/models');

router.use(requireJwtAuth, checkAdmin);

async function buildLogData(message, eventType = 'log') {
  const user = await User.findById(message.user).lean();
  const userInfo = user ? { name: user.name, email: user.email } : { id: message.user };

  return {
    event: eventType, // 'historical_log', 'realtime_log', or 'error'
    type: 'message',  // unified type
    role: message.model ? 'ai' : 'user',
    messageId: message.messageId,
    text: message.text || '',      // works for both queries & responses
    model: message.model || null,  // null for user queries
    user: userInfo,
    tokenCount: message.tokenCount || 0,
    createdAt: message.createdAt.toISOString(),
  };
}

router.get('/queries', async (req, res) => {
  console.log('[logs/queries] Starting SSE response for user:', req.user?.email || 'unknown');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const all = req.query.all === 'true';
  const limit = all ? null : parseInt(req.query.limit) || 100;
  const page = all ? null : parseInt(req.query.page) || 1;
  const skip = all ? 0 : (page - 1) * limit;
  const search = req.query.search ? req.query.search.trim() : null;

  // Build search filter
  const filter = {};
  if (search) {
    filter.$or = [
      { model: { $regex: search, $options: 'i' } }, // ai model
    ];
  }

  try {
    // Find matching users for name/email search
    let matchingUsers = [];
    if (search) {
      matchingUsers = await User.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
        ],
      }).distinct('_id');
      if (matchingUsers.length > 0) {
        filter.$or = filter.$or || [];
        filter.$or.push({ user: { $in: matchingUsers } });
      }
    }

    // Get total count (for init event)
    const total = await Message.countDocuments(filter);

    // Build query
    let query = Message.find(filter)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    if (!all) {
      query = query.skip(skip).limit(limit);
    }

    const historicalLogs = await query;
    console.log(`[logs/queries] Fetched ${historicalLogs.length} historical logs (total: ${total}${all ? '' : `, page: ${page}, limit: ${limit}, skip: ${skip}`})`);

    // Send init message with total count
    res.write(`data: ${JSON.stringify({ type: 'init', count: historicalLogs.length, total })}\n\n`);
    res.flush();

    // Send each historical log
    for (const log of historicalLogs.reverse()) {
      try {
        const logData = await buildLogData(log, 'historical_log');
        res.write(`data: ${JSON.stringify(logData)}\n\n`);
        res.flush();
      } catch (error) {
        console.error(`[logs/queries] Error processing historical log ${log._id}:`, error);
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Error processing historical log' })}\n\n`);
        res.flush();
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'historical_complete' })}\n\n`);
    res.flush();
  } catch (error) {
    console.error('[logs/queries] Error fetching historical logs:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Error fetching historical logs' })}\n\n`);
    res.flush();
    res.end();
    return;
  }

  // Heartbeats to keep connection alive (every 45 seconds to stay well within 60s timeout)
  const heartbeatInterval = setInterval(() => {
    try {
      if (!res.destroyed && !res.finished) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
        res.flush();
      }
    } catch (error) {
      console.error('[logs/queries] Error sending heartbeat:', error);
      clearInterval(heartbeatInterval);
    }
  }, 45000);

  // Track processed IDs for real-time updates
  const processedMessageIds = new Set();

  // Real-time updates
  let changeStream;
  try {
    changeStream = Message.watch([{ $match: { operationType: 'insert' } }], { 
      fullDocument: 'updateLookup',
      maxAwaitTimeMS: 30000 // 30 second timeout for change stream operations
    });

    changeStream.on('change', async (change) => {
      if (change.operationType === 'insert') {
        const newMessage = change.fullDocument;
        if (!newMessage?._id || processedMessageIds.has(newMessage._id.toString())) return;
        processedMessageIds.add(newMessage._id.toString());

        // Apply search filter in real-time
        if (search) {
          const model = newMessage.model || '';
          const user = await User.findById(newMessage.user).lean();
          const name = user?.name || '';
          const email = user?.email || '';
          if (
            !model.match(new RegExp(search, 'i')) &&
            !name.match(new RegExp(search, 'i')) &&
            !email.match(new RegExp(search, 'i'))
          ) {
            return; // skip if it doesn’t match search
          }
        }

        try {
          if (!res.destroyed && !res.finished) {
            const logData = await buildLogData(newMessage, 'realtime_log');
            res.write(`data: ${JSON.stringify(logData)}\n\n`);
            res.flush();
          }
        } catch (error) {
          console.error(`[logs/queries] Error processing real-time log ${newMessage._id}:`, error);
          if (!res.destroyed && !res.finished) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: 'Error processing real-time log' })}\n\n`);
            res.flush();
          }
        }
      }
    });

    changeStream.on('error', (error) => {
      console.error('[logs/queries] Change stream error:', error);
      if (!res.destroyed && !res.finished) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Change stream error', details: error.message })}\n\n`);
        res.flush();
      }
    });
  } catch (err) {
    console.warn('[logs/queries] Change streams unavailable; running without real-time updates:', err?.message || err);
    res.write(`event: warning\ndata: ${JSON.stringify({ message: 'Real-time updates unavailable; showing historical logs only' })}\n\n`);
    res.flush();
  }

  queryLogger.addClient(res);

  req.on('close', () => {
    console.log('[logs/queries] Client disconnected');
    queryLogger.removeClient(res);
    
    // Clean up change stream
    if (changeStream) {
      try {
        changeStream.close();
        console.log('[logs/queries] Change stream closed successfully');
      } catch (err) {
        console.error('[logs/queries] Error closing change stream:', err);
      }
    }
    
    // Clean up heartbeat interval
    clearInterval(heartbeatInterval);
    
    // Ensure response is properly ended
    if (!res.destroyed && !res.finished) {
      try {
        res.end();
      } catch (err) {
        console.error('[logs/queries] Error ending response:', err);
      }
    }
  });

  // Handle other disconnect events
  req.on('error', (error) => {
    console.error('[logs/queries] Request error:', error);
    if (changeStream) {
      try {
        changeStream.close();
      } catch (err) {
        console.error('[logs/queries] Error closing change stream on request error:', err);
      }
    }
    clearInterval(heartbeatInterval);
  });

  // Set a connection timeout (10 minutes)
  const connectionTimeout = setTimeout(() => {
    console.log('[logs/queries] Connection timeout reached, closing connection');
    if (!res.destroyed && !res.finished) {
      res.write(`event: warning\ndata: ${JSON.stringify({ message: 'Connection timeout. Please refresh the page.' })}\n\n`);
      res.flush();
      res.end();
    }
  }, 600000); // 10 minutes

  // Clear timeout on close
  req.on('close', () => {
    clearTimeout(connectionTimeout);
  });
});

// Endpoint to fetch full query by messageId (still available if needed)
router.get('/query/:messageId', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.messageId }).lean();
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }
    res.json({ messageId: message.messageId, query: message.text || '' });
  } catch (error) {
    console.error('[logs/queries] Error fetching full query:', error);
    res.status(500).json({ message: 'Error fetching full query' });
  }
});

module.exports = router;