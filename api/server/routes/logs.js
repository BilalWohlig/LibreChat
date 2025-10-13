const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment');
const router = express.Router();
const { requireJwtAuth, checkAdmin } = require('~/server/middleware');
const queryLogger = require('~/server/services/QueryLogger');
const { Message, User, Conversation } = require('~/db/models');
const { exportQueryLogsToCSV } = require('~/server/utils/excelExport');
const { logger } = require('~/config');

router.use(requireJwtAuth, checkAdmin);

/** ---------------- Shared Helpers ---------------- **/

const buildFilterFromQuery = (query = {}) => {
  const { search } = query;
  const filter = {};
  let userMatchExpr = null;

  if (search && search.trim()) {
    const searchTerm = search.trim();
    logger.info('[buildFilterFromQuery] Building search filter for:', searchTerm);

    userMatchExpr = {
      $expr: {
        $or: [
          { $regexMatch: { input: { $ifNull: ['$userInfo.name', ''] }, regex: searchTerm, options: 'i' } },
          { $regexMatch: { input: { $ifNull: ['$userInfo.email', ''] }, regex: searchTerm, options: 'i' } },
          { $regexMatch: { input: { $ifNull: ['$conversationDoc.title', ''] }, regex: searchTerm, options: 'i' } },
        ],
      },
    };
  }

  return { filter, userMatchExpr };
};

const buildConversationsAggregation = (filter, userMatchExpr, { skip = 0, limitNum = 10 }) => {
  const pipeline = [
    { $match: filter },
    {
      $group: {
        _id: '$conversationId',
        user: { $first: '$user' },
        createdAt: { $min: '$createdAt' },
        updatedAt: { $max: '$createdAt' },
        totalTokens: { $sum: { $ifNull: ['$tokenCount', 0] } },
        messageCount: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        let: { userId: '$user' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: [
                  '$_id',
                  {
                    $cond: [
                      { $eq: [{ $type: '$$userId' }, 'objectId'] },
                      '$$userId',
                      { $toObjectId: '$$userId' },
                    ],
                  },
                ],
              },
            },
          },
          { $project: { name: 1, email: 1 } },
        ],
        as: 'userInfo',
      },
    },
    { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'conversations',
        localField: '_id',
        foreignField: 'conversationId',
        as: 'conversationDoc',
      },
    },
    { $unwind: { path: '$conversationDoc', preserveNullAndEmptyArrays: true } },
    ...(userMatchExpr ? [{ $match: userMatchExpr }] : []),
    {
      $project: {
        conversationId: '$_id',
        user: {
          name: '$userInfo.name',
          email: '$userInfo.email',
          id: '$user',
        },
        title: { $ifNull: ['$conversationDoc.title', 'New Chat'] },
        createdAt: 1,
        updatedAt: 1,
        totalTokens: 1,
        messageCount: 1,
      },
    },
    { $sort: { updatedAt: -1 } },
    { $skip: skip },
    { $limit: limitNum },
  ];
  return pipeline;
};

const fetchConversations = async (query = {}) => {
  const pageNum = Math.max(parseInt(query.page ?? 1, 10), 1);
  const limitQ = Math.min(Math.max(parseInt(query.limit ?? 10, 10), 1), 100);
  const all = query.all === 'true';

  const { filter, userMatchExpr } = buildFilterFromQuery(query);
  logger.info('[fetchConversations] Query params:', query);

  // Count pipeline
  const countPipeline = [
    { $match: filter },
    {
      $group: {
        _id: '$conversationId',
        user: { $first: '$user' },
      },
    },
    {
      $lookup: {
        from: 'users',
        let: { userId: '$user' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: [
                  '$_id',
                  {
                    $cond: [
                      { $eq: [{ $type: '$$userId' }, 'objectId'] },
                      '$$userId',
                      { $toObjectId: '$$userId' },
                    ],
                  },
                ],
              },
            },
          },
          { $project: { name: 1, email: 1 } },
        ],
        as: 'userInfo',
      },
    },
    { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'conversations',
        localField: '_id',
        foreignField: 'conversationId',
        as: 'conversationDoc',
      },
    },
    { $unwind: { path: '$conversationDoc', preserveNullAndEmptyArrays: true } },
    ...(userMatchExpr ? [{ $match: userMatchExpr }] : []),
    { $count: 'total' },
  ];

  let totalCount = 0;
  try {
    const [countResult] = await Message.aggregate(countPipeline);
    totalCount = countResult?.total || 0;
    logger.info('[fetchConversations] Total:', totalCount);
  } catch (err) {
    logger.error('[fetchConversations] Count error:', err);
  }

  const skip = all ? 0 : (pageNum - 1) * limitQ;
  const limitNum = all ? Math.max(totalCount, 1) : limitQ;

  let conversations = [];
  try {
    conversations = await Message.aggregate(
      buildConversationsAggregation(filter, userMatchExpr, { skip, limitNum })
    );
    logger.info('[fetchConversations] Retrieved:', conversations.length);
  } catch (err) {
    logger.error('[fetchConversations] Fetch error:', err);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / limitNum));

  return {
    conversations,
    pagination: {
      currentPage: Math.min(pageNum, totalPages),
      totalPages,
      totalCount,
      hasNext: pageNum < totalPages,
      hasPrev: pageNum > 1,
    },
  };
};

/** ---------------- End Helpers ---------------- **/

async function buildLogData(message, eventType = 'log') {
  const user = await User.findById(message.user).lean();
  const userInfo = user ? { name: user.name, email: user.email, id: message.user } : { id: message.user };

  return {
    event: eventType,
    type: 'message',
    role: message.model ? 'assistant' : message.toolCalls?.length ? 'tool' : 'user',
    messageId: message.messageId,
    text: message.text || '',
    model: message.model || null,
    user: userInfo,
    tokenCount: message.tokenCount || 0,
    createdAt: message.createdAt.toISOString(),
    toolType: message.toolCalls?.[0]?.type || null,
    searchQuery: message.toolCalls?.find(t => t.type === 'web_search')?.query || null,
    attachments : message.attachments || null,
  };
}

// Endpoint: Fetch individual query
router.get('/query/:messageId', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.messageId }).lean();
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }
    res.json({ messageId: message.messageId, query: message.text || '' });
  } catch (error) {
    logger.error('[logs/query] Error:', error);
    res.status(500).json({ message: 'Error fetching full query' });
  }
});

// Endpoint: Export query logs to CSV
router.get('/queries/export', async (req, res) => {
  try {
    const { search } = req.query;
    const filter = {};

    if (search && search.trim()) {
      const searchTerm = search.trim();
      filter.$or = [
        { model: { $regex: searchTerm, $options: 'i' } },
        { text: { $regex: searchTerm, $options: 'i' } },
      ];

      const matchingUsers = await User.find({
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      }).distinct('_id');

      if (matchingUsers.length > 0) {
        filter.$or.push({ user: { $in: matchingUsers } });
      }
    }

    const messages = await Message.find(filter)
      .populate({ path: 'user', select: 'name email', model: 'User' })
      .select('user text model tokenCount createdAt toolCalls conversationId')
      .sort({ createdAt: -1 })
      .lean();

    if (!messages || messages.length === 0) {
      return res.status(404).json({ message: 'No query logs found' });
    }

    const conversationIds = [...new Set(messages.map((m) => m.conversationId))];
    const conversations = await Conversation.find({ conversationId: { $in: conversationIds } })
      .select('conversationId title')
      .lean();
    const conversationTitleMap = conversations.reduce((acc, conv) => {
      acc[conv.conversationId] = conv.title || 'New Chat';
      return acc;
    }, {});

    const formattedLogs = messages.map((message) => ({
      role: message.model ? 'assistant' : message.toolCalls?.length ? 'tool' : 'user',
      model: message.model || '',
      text: message.text || '',
      tokenCount: message.tokenCount || 0,
      createdAt: message.createdAt,
      userName: message.user?.name || '',
      userEmail: message.user?.email || '',
      toolType: message.toolCalls?.[0]?.type || null,
      searchQuery: message.toolCalls?.find(t => t.type === 'web_search')?.query || null,
      conversationId: message.conversationId,
      conversationTitle: conversationTitleMap[message.conversationId] || 'New Chat',
    }));

    const csv = await exportQueryLogsToCSV(formattedLogs);
    const date = new Date().toISOString().split('T')[0];
    const filename = `query-logs-${date}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');

    return res.send(csv);
  } catch (error) {
    logger.error('[logs/queries/export] Error:', error);
    return res.status(500).json({ message: 'Failed to export', error: error.message });
  }
});


// --- **Replaced** conversations/export logic — flat CSV export of messages
router.get('/conversations/export', async (req, res) => {
  try {
    const { search } = req.query;
    const filter = {};

    if (search && search.trim()) {
      const searchTerm = search.trim();
      filter.$or = [
        { model: { $regex: searchTerm, $options: 'i' } },
      ];

      const matchingUsers = await User.find({
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      }).distinct('_id');

      if (matchingUsers.length > 0) {
        filter.$or.push({ user: { $in: matchingUsers } });
      }
    }

    const messages = await Message.find(filter)
      .populate({ path: 'user', select: 'name email', model: 'User' })
      .select('user text model tokenCount createdAt toolCalls conversationId')
      .sort({ createdAt: -1 })  // Latest first
      .lean();

    if (!messages || messages.length === 0) {
      return res.status(404).json({ message: 'No messages found matching the criteria' });
    }

    const formattedLogs = messages.map((message) => {
      const user = message.user || {};
      const isAI = !!message.model;

      return {
        conversationId: message.conversationId,
        role: isAI ? 'assistant' : 'user',
        model: message.model || '',
        text: message.text || '',
        tokenCount: message.tokenCount || 0,
        createdAt: message.createdAt,
        userName: user.name || '',
        userEmail: user.email || '',
        toolType: message.toolCalls?.[0]?.type || null,
        searchQuery: message.toolCalls?.find(t => t.type === 'web_search')?.query || null,
      };
    });

    const csv = await exportQueryLogsToCSV(formattedLogs);
    const date = new Date().toISOString().split('T')[0];
    const filename = `conversations-${date}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');

    return res.send(csv);
  } catch (error) {
    logger.error('[logs/conversations/export] Error generating CSV:', error);
    return res.status(500).json({ message: 'Failed to export conversation messages', error: error.message });
  }
});


// Endpoint: Export messages for a specific conversation
router.get('/conversations/:conversationId/export', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { search } = req.query;

    const filter = { conversationId };
    if (search && search.trim()) {
      const searchTerm = search.trim();
      filter.$or = [
        { model: { $regex: searchTerm, $options: 'i' } },
        { text: { $regex: searchTerm, $options: 'i' } },
      ];
      const matchingUsers = await User.find({
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      }).distinct('_id');
      if (matchingUsers.length > 0) {
        filter.$or.push({ user: { $in: matchingUsers } });
      }
    }

    const messages = await Message.find(filter)
      .populate({ path: 'user', select: 'name email', model: 'User' })
      .select('user text model tokenCount createdAt toolCalls')
      .sort({ createdAt: -1 })  // Latest first
      .lean();

    if (!messages || messages.length === 0) {
      return res.status(404).json({ message: 'No messages found for this conversation' });
    }

    const conversation = await Conversation.findOne({ conversationId }).select('title').lean();
    const title = conversation?.title || 'New Chat';

    const formattedLogs = messages.map((message) => ({
      role: message.model ? 'assistant' : message.toolCalls?.length ? 'tool' : 'user',
      model: message.model || '',
      text: message.text || '',
      tokenCount: message.tokenCount || 0,
      createdAt: message.createdAt,
      userName: message.user?.name || '',
      userEmail: message.user?.email || '',
      toolType: message.toolCalls?.[0]?.type || null,
      searchQuery: message.toolCalls?.find(t => t.type === 'web_search')?.query || null,
      conversationId,
      conversationTitle: title,
    }));

    const csv = await exportQueryLogsToCSV(formattedLogs);
    const date = new Date().toISOString().split('T')[0];
    const filename = `conversation-${conversationId}-${date}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');

    return res.send(csv);
  } catch (error) {
    logger.error(`[logs/conversations/${req.params.conversationId}/export] Error:`, error);
    return res.status(500).json({ message: 'Failed to export', error: error.message });
  }
});

// SSE: conversations list
router.get('/conversations', async (req, res) => {
  logger.info('[logs/conversations] SSE start for:', req.user?.email);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('retry: 10000\n\n');
  res.flushHeaders();

  const heartbeatInterval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    res.flush();
  }, 30000);

  let changeStream;
  let convoChangeStream;
  const processedConversationIds = new Set();

  try {
    const { conversations, pagination } = await fetchConversations(req.query);

    res.write(`data: ${JSON.stringify({ 
      type: 'init', 
      total: pagination.totalCount, 
      count: conversations.length,
      pagination 
    })}\n\n`);
    res.flush();

    for (const convo of conversations) {
      const payload = {
        event: 'historical_conversation',
        conversationId: convo.conversationId,
        user: convo.user,
        title: convo.title,
        createdAt: convo.createdAt.toISOString(),
        updatedAt: convo.updatedAt.toISOString(),
        totalTokens: convo.totalTokens,
        messageCount: convo.messageCount,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.flush();
      processedConversationIds.add(convo.conversationId);
    }

    res.write(`data: ${JSON.stringify({ type: 'historical_complete' })}\n\n`);
    res.flush();

    const { filter, userMatchExpr } = buildFilterFromQuery(req.query);
    changeStream = Message.watch([{ $match: { operationType: 'insert', ...filter } }], { fullDocument: 'updateLookup' });

    changeStream.on('change', async (change) => {
      if (change.operationType !== 'insert') return;
      const newMessage = change.fullDocument;
      if (!newMessage?.conversationId) return;

      try {
        const [summary] = await Message.aggregate([
          { $match: { conversationId: newMessage.conversationId } },
          ...buildConversationsAggregation({}, userMatchExpr, { skip: 0, limitNum: 1 }).slice(1),
        ]);

        if (!summary) return;

        if (userMatchExpr && req.query.search && req.query.search.trim()) {
          const searchTerm = req.query.search.trim();
          const name = summary.user?.name || '';
          const email = summary.user?.email || '';
          const title = summary.title || '';

          if (
            !new RegExp(searchTerm, 'i').test(name) &&
            !new RegExp(searchTerm, 'i').test(email) &&
            !new RegExp(searchTerm, 'i').test(title)
          ) {
            return;
          }
        }

        const tokenUpdatePayload = {
          event: 'conversation_update',
          type: 'tokens',
          conversationId: summary.conversationId,
          totalTokens: summary.totalTokens,
          messageCount: summary.messageCount,
          updatedAt: summary.updatedAt.toISOString(),
        };
        res.write(`data: ${JSON.stringify(tokenUpdatePayload)}\n\n`);
        res.flush();

        if (!processedConversationIds.has(newMessage.conversationId)) {
          processedConversationIds.add(newMessage.conversationId);

          const conversationData = {
            event: 'realtime_conversation',
            type: 'conversation_summary',
            conversationId: summary.conversationId,
            user: summary.user,
            title: summary.title,
            createdAt: summary.createdAt.toISOString(),
            updatedAt: summary.updatedAt.toISOString(),
            totalTokens: summary.totalTokens,
            messageCount: summary.messageCount,
          };
          res.write(`data: ${JSON.stringify(conversationData)}\n\n`);
          res.flush();
        }
      } catch (error) {
        logger.error('[logs/conversations] Real-time error:', error);
      }
    });

    changeStream.on('error', (error) => {
      logger.error('[logs/conversations] Change stream error:', error);
    });

    convoChangeStream = Conversation.watch([{ $match: { operationType: 'update' } }], { fullDocument: 'updateLookup' });

    convoChangeStream.on('change', async (change) => {
      try {
        const updatedFields = change.updateDescription?.updatedFields || {};
        if (!('title' in updatedFields)) return;

        const convDoc = change.fullDocument ||
          (await Conversation.findById(change.documentKey?._id).select('conversationId title updatedAt user').lean());
        if (!convDoc?.conversationId) return;

        if (req.query.search && req.query.search.trim()) {
          const searchTerm = req.query.search.trim();
          const user = await User.findById(convDoc.user).lean();
          const name = user?.name || '';
          const email = user?.email || '';

          if (
            !new RegExp(searchTerm, 'i').test(name) &&
            !new RegExp(searchTerm, 'i').test(email) &&
            !new RegExp(searchTerm, 'i').test(convDoc.title)
          ) {
            return;
          }
        }

        const payload = {
          event: 'conversation_update',
          type: 'title',
          conversationId: convDoc.conversationId,
          title: convDoc.title || 'New Chat',
          updatedAt: (convDoc.updatedAt ? new Date(convDoc.updatedAt).toISOString() : new Date().toISOString()),
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.flush();
      } catch (err) {
        logger.error('[logs/conversations] Title update error:', err);
      }
    });

    convoChangeStream.on('error', (err) => {
      logger.error('[logs/conversations] Convo change stream error:', err);
    });
  } catch (err) {
    logger.error('[logs/conversations] Setup error:', err);
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Error setting up connection' })}\n\n`);
    res.flush();
  }

  queryLogger.addClient(res);

  req.on('close', () => {
    logger.info('[logs/conversations] Client disconnected');
    queryLogger.removeClient(res);
    if (changeStream) changeStream.close();
    if (convoChangeStream) convoChangeStream.close();
    clearInterval(heartbeatInterval);
    res.end();
  });
});

// SSE: messages in a conversation
router.get('/conversations/:conversationId/messages', async (req, res) => {
  const { conversationId } = req.params;
  logger.info('[logs/conversations/messages] Start SSE for:', conversationId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('retry: 10000\n\n');
  res.flushHeaders();

  try {
    const messages = await Message.find({ conversationId })
      .select('messageId conversationId user model text tokenCount createdAt toolCalls attachments')
      .sort({ createdAt: 1 })
      .lean();

    const uniqueUserIds = Array.from(
      new Set(
        messages
          .map((m) => (typeof m.user === 'string' ? m.user : null))
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id)),
      ),
    );

    let userInfoMap = {};
    if (uniqueUserIds.length) {
      const userDocs = await User.find({
        _id: { $in: uniqueUserIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
        .select('name email')
        .lean();

      userInfoMap = userDocs.reduce((acc, u) => {
        acc[u._id.toString()] = {
          name: u.name || 'Unknown',
          email: u.email || 'N/A',
          id: u._id.toString(),
        };
        return acc;
      }, {});
    }

    res.write(`data: ${JSON.stringify({ type: 'init', conversationId, count: messages.length })}\n\n`);
    res.flush();

    for (const message of messages) {
      try {
        const messageData = await buildLogData(message, 'historical_message');
        res.write(`data: ${JSON.stringify(messageData)}\n\n`);
        res.flush();
      } catch (error) {
        logger.error('[logs/conversations/messages] Message error:', error);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'historical_complete' })}\n\n`);
    res.flush();
  } catch (error) {
    logger.error('[logs/conversations/messages] Fetch error:', error);
    res.write(`data: ${JSON.stringify({ type: 'init', conversationId, count: 0 })}\n\n`);
    res.flush();
  }

  const heartbeatInterval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    res.flush();
  }, 30000);

  const processedMessageIds = new Set();
  let changeStream;

  try {
    changeStream = Message.watch(
      [{ $match: { operationType: 'insert', 'fullDocument.conversationId': conversationId } }],
      { fullDocument: 'updateLookup' },
    );

    changeStream.on('change', async (change) => {
      if (change.operationType !== 'insert') return;
      const newMessage = change.fullDocument;
      if (!newMessage?._id || processedMessageIds.has(newMessage._id.toString())) return;
      processedMessageIds.add(newMessage._id.toString());

      try {
        const messageData = await buildLogData(newMessage, 'realtime_message');
        res.write(`data: ${JSON.stringify(messageData)}\n\n`);
        res.flush();
      } catch (error) {
        logger.error('[logs/conversations/messages] Real-time message error:', error);
      }
    });

    changeStream.on('error', (error) => {
      logger.error('[logs/conversations/messages] Change stream error:', error);
    });
  } catch (err) {
    logger.warn('[logs/conversations/messages] Change stream unavailable:', err);
  }

  queryLogger.addClient(res);

  req.on('close', () => {
    logger.info('[logs/conversations/messages] Client disconnected');
    queryLogger.removeClient(res);
    if (changeStream) changeStream.close();
    clearInterval(heartbeatInterval);
    res.end();
  });
});

// Endpoint: Test database
router.get('/test', requireJwtAuth, checkAdmin, async (req, res) => {
  try {
    const totalCount = await Message.aggregate([
      { $group: { _id: '$conversationId' } },
      { $count: 'total' },
    ]);
    const recentConversations = await Message.aggregate([
      {
        $group: {
          _id: '$conversationId',
          createdAt: { $min: '$createdAt' },
          updatedAt: { $max: '$createdAt' },
        },
      },
      { $sort: { updatedAt: -1 } },
      { $limit: 5 },
    ]);
    res.json({
      success: true,
      data: {
        totalCount: totalCount[0]?.total || 0,
        recentConversations,
        message: 'Database check completed',
      },
    });
  } catch (error) {
    logger.error('[logs/test] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to check database' });
  }
});

module.exports = router;
