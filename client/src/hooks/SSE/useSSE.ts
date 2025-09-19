import { useEffect, useState } from 'react';
import { v4 } from 'uuid';
import { SSE } from 'sse.js';
import { useSetRecoilState } from 'recoil';
import {
  request,
  Constants,
  /* @ts-ignore */
  createPayload,
  isAgentsEndpoint,
  LocalStorageKeys,
  removeNullishValues,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TMessage, TPayload, TSubmission, EventSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData } from '~/common';
import { useGenTitleMutation, useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import useEventHandlers from './useEventHandlers';
import store from '~/store';

const clearDraft = (conversationId?: string | null) => {
  if (conversationId) {
    localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`);
    localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`);
  } else {
    localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`);
    localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`);
  }
};

type ChatHelpers = Pick<
  EventHandlerParams,
  | 'setMessages'
  | 'getMessages'
  | 'setConversation'
  | 'setIsSubmitting'
  | 'newConversation'
  | 'resetLatestMessage'
>;

export default function useSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const genTitle = useGenTitleMutation();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
  const [completed, setCompleted] = useState(new Set());
  const [activeSSE, setActiveSSE] = useState<InstanceType<typeof SSE> | null>(null);
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));

  const {
    setMessages,
    getMessages,
    setConversation,
    setIsSubmitting,
    newConversation,
    resetLatestMessage,
  } = chatHelpers;

  const {
    stepHandler,
    syncHandler,
    finalHandler,
    errorHandler,
    messageHandler,
    contentHandler,
    createdHandler,
    attachmentHandler,
    abortConversation,
  } = useEventHandlers({
    genTitle,
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
    resetLatestMessage,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });

  // Separate effect to handle explicit stop (when submission becomes null)
  useEffect(() => {
    if (submission === null && activeSSE) {
      console.log('Explicit stop detected - closing SSE connection and aborting backend');
      
      // Close the SSE connection
      if (activeSSE.readyState === 1) { // OPEN state
        activeSSE.close();
      }
      
      // Call abortConversation to properly clean up backend
      const latestMessages = getMessages();
      const userMessage = latestMessages?.find(msg => msg.isCreatedByUser);
      if (userMessage) {
        const conversationId = latestMessages?.[latestMessages.length - 1]?.conversationId;
        abortConversation(
          conversationId ?? userMessage.conversationId ?? '',
          { userMessage } as EventSubmission,
          latestMessages,
        );
      }
      
      setActiveSSE(null);
    }
  }, [submission, activeSSE, getMessages, abortConversation]);

  useEffect(() => {
    if (submission == null || Object.keys(submission).length === 0) {
      return;
    }

    let { userMessage } = submission;

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    if (isAssistantsEndpoint(payload.endpoint) || isAgentsEndpoint(payload.endpoint)) {
      payload = removeNullishValues(payload) as TPayload;
    }

    let textIndex = null;
    let isExplicitStop = false;

    const sse = new SSE(payloadData.server, {
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });

    // Store the SSE instance so the explicit stop effect can access it
    setActiveSSE(sse);

    sse.addEventListener('attachment', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        attachmentHandler({ data, submission: submission as EventSubmission });
      } catch (error) {
        console.error(error);
      }
    });

    let explicitlyClosing = false;

    sse.addEventListener('message', (e: MessageEvent) => {
      const data = JSON.parse(e.data);

      if (data.final != null) {
        clearDraft(submission.conversation?.conversationId);
        const { plugins } = data;
        finalHandler(data, { ...submission, plugins } as EventSubmission);
        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
        console.log('final', data);
        return;
      } else if (data.created != null) {
        const runId = v4();
        setActiveRunId(runId);
        userMessage = {
          ...userMessage,
          ...data.message,
          overrideParentMessageId: userMessage.overrideParentMessageId,
        };

        createdHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.event != null) {
        stepHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.sync != null) {
        const runId = v4();
        setActiveRunId(runId);
        /* synchronize messages to Assistants API as well as with real DB ID's */
        syncHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.type != null) {
        const { text, index } = data;
        if (text != null && index !== textIndex) {
          textIndex = index;
        }

        contentHandler({ data, submission: submission as EventSubmission });
      } else {
        const text = data.text ?? data.response;
        const { plugin, plugins } = data;

        const initialResponse = {
          ...(submission.initialResponse as TMessage),
          parentMessageId: data.parentMessageId,
          messageId: data.messageId,
        };

        if (data.message != null) {
          messageHandler(text, { ...submission, plugin, plugins, userMessage, initialResponse });
        }
      }
    });

    sse.addEventListener('open', () => {
      setAbortScroll(false);
      console.log('connection is opened');
    });

    sse.addEventListener('cancel', async () => {
      const streamKey = (submission as TSubmission | null)?.['initialResponse']?.messageId;
      if (completed.has(streamKey)) {
        setIsSubmitting(false);
        setCompleted((prev) => {
          prev.delete(streamKey);
          return new Set(prev);
        });
        return;
      }

      setCompleted((prev) => new Set(prev.add(streamKey)));
      const latestMessages = getMessages();
      const conversationId = latestMessages?.[latestMessages.length - 1]?.conversationId;
      
      // Always abort when the cancel event is received from SSE stream
      isExplicitStop = true;
      return await abortConversation(
        conversationId ??
          userMessage.conversationId ??
          submission.conversation?.conversationId ??
          '',
        submission as EventSubmission,
        latestMessages,
      );
    });

    sse.addEventListener('error', async (e: MessageEvent) => {
      /* @ts-ignore */
      if (e.responseCode === 401) {
        /* token expired, refresh and retry */
        try {
          const refreshResponse = await request.refreshToken();
          const token = refreshResponse?.token ?? '';
          if (!token) {
            throw new Error('Token refresh failed.');
          }
          sse.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };

          request.dispatchTokenUpdatedEvent(token);
          sse.stream();
          return;
        } catch (error) {
          /* token refresh failed, continue handling the original 401 */
          console.log(error);
        }
      }

      console.log('error in server stream.');
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();

      let data: TResData | undefined = undefined;
      try {
        data = JSON.parse(e.data) as TResData;
      } catch (error) {
        console.error(error);
        console.log(e);
        setIsSubmitting(false);
      }

      errorHandler({ data, submission: { ...submission, userMessage } as EventSubmission });
    });

    setIsSubmitting(true);
    sse.stream();

    return () => {
      // This cleanup handles navigation away - we don't want to abort the backend
      if (sse.readyState === 2) { // CLOSED state - connection already closed
        return;
      }
      
      // For navigation away, we keep the backend processing
      // The explicit stop is handled by the separate effect above
      console.log('SSE cleanup called due to navigation - allowing background generation to continue');
      setActiveSSE(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

    // Separate effect to handle explicit stop (when submission becomes null)
  useEffect(() => {
    if (submission === null && activeSSE) {
      console.log('Explicit stop detected - closing SSE connection and aborting backend');
      
      // Close the SSE connection
      if (activeSSE.readyState === 1) { // OPEN state
        activeSSE.close();
      }
      
      // Call abortConversation to properly clean up backend
      const latestMessages = getMessages();
      const userMessage = latestMessages?.find(msg => msg.isCreatedByUser);
      if (userMessage) {
        const conversationId = latestMessages?.[latestMessages.length - 1]?.conversationId;
        abortConversation(
          conversationId ?? userMessage.conversationId ?? '',
          { userMessage } as EventSubmission,
          latestMessages,
        );
      }
      
      setActiveSSE(null);
    }
  }, [submission, activeSSE, getMessages, abortConversation]);

  // Check for unfinished messages and attempt to reconnect streaming
  useEffect(() => {
    // Only run for main chat (not added requests)
    if (isAddedRequest) {
      return;
    }

    // Skip if there's already an active submission
    if (submission) {
      return;
    }

    const currentMessages = getMessages();
    if (!currentMessages || currentMessages.length === 0) {
      return;
    }

    // Look for unfinished messages
    const unfinishedMessages = currentMessages.filter(msg => 
      !msg.isCreatedByUser && msg.unfinished === true
    );

    if (unfinishedMessages.length === 0) {
      return;
    }

    // Get the latest unfinished message
    const latestUnfinishedMessage = unfinishedMessages[unfinishedMessages.length - 1];
    
    // Check if this is actually the latest message
    const sortedMessages = [...currentMessages].sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeA - timeB;
    });
    
    const actualLatestMessage = sortedMessages[sortedMessages.length - 1];
    
    if (actualLatestMessage?.messageId !== latestUnfinishedMessage.messageId) {
      return;
    }

    // Only proceed if the message is recent (within last 5 minutes)
    if (latestUnfinishedMessage.createdAt) {
      const messageTime = new Date(latestUnfinishedMessage.createdAt).getTime();
      const now = new Date().getTime();
      const fiveMinutesAgo = now - (5 * 60 * 1000);
      
      if (messageTime < fiveMinutesAgo) {
        return;
      }
    }

    console.log('SSE: Detected recent unfinished message, setting up completion polling:', latestUnfinishedMessage.messageId);
    
    // Set up polling to detect when the message completes
    const pollInterval = setInterval(() => {
      // Refetch messages to check for completion
      const refreshedMessages = getMessages();
      const refreshedUnfinishedMessage = refreshedMessages?.find(
        msg => msg.messageId === latestUnfinishedMessage.messageId
      );
      
      if (refreshedUnfinishedMessage && !refreshedUnfinishedMessage.unfinished) {
        console.log('SSE: Unfinished message completed, clearing polling');
        clearInterval(pollInterval);
        setIsSubmitting(false);
      }
    }, 2000);

    // Set submitting state to show loading UI
    setIsSubmitting(true);

    // Clean up after 60 seconds
    setTimeout(() => {
      clearInterval(pollInterval);
      setIsSubmitting(false);
    }, 60000);

    return () => {
      clearInterval(pollInterval);
      setIsSubmitting(false);
    };
  }, [submission, isAddedRequest, getMessages, setIsSubmitting]);
}
