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

/* -------------------- GLOBAL MAP FOR BACKGROUND STREAMS -------------------- */
const globalSSEMap = new Map<string, InstanceType<typeof SSE>>();

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
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));

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

  /* -------------------- EXPLICIT STOP HANDLER -------------------- */
  useEffect(() => {
    // Only stop explicitly if user cancels, not on navigation
    if (submission === null && activeSSE) {
      console.log('Explicit stop detected - leaving background stream intact');
      // Do NOT close activeSSE here — allow background streaming
      setIsSubmitting(false);
    }
  }, [submission, activeSSE, setIsSubmitting]);

  /* -------------------- MAIN SSE EFFECT -------------------- */
  useEffect(() => {
    if (submission == null || Object.keys(submission).length === 0) {
      return;
    }

    const conversationId = submission.conversation?.conversationId ?? '';

    // **CRITICAL FIX: CAPTURE ROUTE IMMEDIATELY WHEN SUBMISSION STARTS**
    const submissionStartRoute = {
      pathname: window.location.pathname,
      conversationId: conversationId,
      timestamp: Date.now(),
    };
    console.log('📍 Submission started at route:', submissionStartRoute);

    /* -------- Check for existing background stream -------- */
    const existingSSE = globalSSEMap.get(conversationId);
    if (existingSSE && existingSSE.readyState === 1) {
      console.log('Reusing active background SSE stream for conversation', conversationId);
      setActiveSSE(existingSSE);
      return;
    }

    const submissionKey = `activeSSE_${submission.userMessage?.messageId || conversationId}`;
    const hasActiveSSE = localStorage.getItem(submissionKey) === 'true';

    if (hasActiveSSE && activeSSE) {
      console.log('SSE: Preventing reconnection during navigation');
      return;
    }

    let { userMessage } = submission;

    if (!userMessage || !userMessage.messageId) {
      console.warn('SSE: Invalid submission - missing userMessage or messageId');
      setIsSubmitting(false);
      return;
    }

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    if (isAssistantsEndpoint(payload.endpoint) || isAgentsEndpoint(payload.endpoint)) {
      payload = removeNullishValues(payload) as TPayload;
    }

    let textIndex = null;
    let isExplicitStop = false;

    const sseKey = `sse_${submission.initialResponse?.messageId || userMessage?.messageId || ''}`;
    if (sseKey && localStorage.getItem(sseKey) === 'open') {
      console.log('SSE: Stream already open for this message');
      return;
    }

    const currentMessages = getMessages();
    if (currentMessages && currentMessages.length > 0) {
      const responseId = submission.initialResponse?.messageId;
      const userMsgId = userMessage.messageId;

      if (responseId && completed.has(responseId)) {
        console.log('SSE: Message already completed, skipping regeneration');
        setSubmission(null);
        setIsSubmitting(false);
        return;
      }

      const responseExists = currentMessages.some((msg) => {
        if (msg.messageId === userMsgId) return false;
        const isPlaceholder = msg.messageId?.endsWith('_') && (!msg.text || msg.text.length === 0);
        if (isPlaceholder) return false;
        if (msg.parentMessageId === userMsgId && !msg.isCreatedByUser) {
          const hasContent = msg.text && msg.text.length > 0;
          const isFinished = !msg.unfinished;
          return hasContent && isFinished;
        }
        return false;
      });

      if (responseExists) {
        console.log('SSE: Completed response already exists, preventing retrigger');
        setSubmission(null);
        setIsSubmitting(false);
        return;
      }
    }

    /* -------------------- CREATE AND STREAM SSE -------------------- */
    const sse = new SSE(payloadData.server, {
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });

    (sse as any)._submissionMeta = {
      userMessageId: userMessage.messageId,
      conversationId,
    };

    setActiveSSE(sse);
    globalSSEMap.set(conversationId, sse);

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
        localStorage.removeItem(submissionKey);
        localStorage.removeItem(sseKey);
        console.log('SSE: Final message received, cleared flags');

        (sse as any)._submissionMeta = null;
        clearDraft(conversationId);
        const { plugins } = data;
        
        // **PASS THE CAPTURED ROUTE TO finalHandler**
        finalHandler(data, { 
          ...submission, 
          plugins,
          _submissionRoute: submissionStartRoute  // <-- CRITICAL: Pass captured route
        } as EventSubmission);
        
        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();

        // Mark as completed and clear submission
        setSubmission(null);
        setIsSubmitting(false);
        globalSSEMap.delete(conversationId);
        console.log('SSE: Cleared submission after final message');
        return;
      } else if (data.created != null) {
        const runId = v4();
        setActiveRunId(runId);
        userMessage = {
          ...userMessage,
          ...data.message,
          overrideParentMessageId: userMessage?.overrideParentMessageId,
        };
        createdHandler(data, { 
          ...submission, 
          userMessage,
          _submissionRoute: submissionStartRoute  // <-- Also pass to createdHandler
        } as EventSubmission);
      } else if (data.event != null) {
        stepHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.sync != null) {
        const runId = v4();
        setActiveRunId(runId);
        syncHandler(data, { 
          ...submission, 
          userMessage,
          _submissionRoute: submissionStartRoute  // <-- Also pass to syncHandler
        } as EventSubmission);
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
      console.log('SSE: connection opened');
      localStorage.setItem(submissionKey, 'true');
      if (sseKey) {
        localStorage.setItem(sseKey, 'open');
      }
    });

    sse.addEventListener('cancel', async () => {
      const streamKey = submission?.initialResponse?.messageId;
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
      const convoId =
        latestMessages?.[latestMessages.length - 1]?.conversationId ?? conversationId;

      isExplicitStop = true;
      return await abortConversation(convoId, submission as EventSubmission, latestMessages);
    });

    sse.addEventListener('error', async (e: MessageEvent) => {
      /* @ts-ignore */
      if (e.responseCode === 401) {
        try {
          const refreshResponse = await request.refreshToken();
          const token = refreshResponse?.token ?? '';
          if (!token) throw new Error('Token refresh failed.');
          sse.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };
          request.dispatchTokenUpdatedEvent(token);
          sse.stream();
          return;
        } catch (error) {
          console.log('SSE token refresh failed:', error);
        }
      }

      console.log('SSE: error in server stream.');
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
      localStorage.removeItem(submissionKey);
      localStorage.removeItem(sseKey);

      let data: TResData | undefined;
      try {
        data = JSON.parse(e.data) as TResData;
      } catch (error) {
        console.error(error);
        console.log(e);
        setIsSubmitting(false);
      }
      errorHandler({ data, submission: { ...submission, userMessage } as EventSubmission });
      globalSSEMap.delete(conversationId);
    });

    setIsSubmitting(true);
    sse.stream();

    /* -------------------- CLEANUP ON UNMOUNT -------------------- */
    return () => {
      // Keep stream alive for background generation
      if (conversationId && sse.readyState === 1) {
        globalSSEMap.set(conversationId, sse);
        console.log(`SSE background streaming preserved for conversation ${conversationId}`);
        return;
      }

      // Cleanup fully closed or errored SSEs
      if (sse.readyState === 2) {
        globalSSEMap.delete(conversationId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);
}