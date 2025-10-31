import { useCallback, useState, useEffect } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilState, useResetRecoilState, useSetRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import useChatFunctions from '~/hooks/Chat/useChatFunctions';
import { useGetMessagesByConvoId } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import useNewConvo from '~/hooks/useNewConvo';
import store from '~/store';

// this to be set somewhere else
export default function useChatHelpers(index = 0, paramId?: string) {
  const clearAllSubmissions = store.useClearSubmissionState();
  const [files, setFiles] = useRecoilState(store.filesByIndex(index));
  const [filesLoading, setFilesLoading] = useState(false);

  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuthContext();

  const { newConversation } = useNewConvo(index);
  const { useCreateConversationAtom } = store;
  const { conversation, setConversation } = useCreateConversationAtom(index);
  const { conversationId } = conversation ?? {};

  const queryParam = paramId === 'new' ? paramId : (conversationId ?? paramId ?? '');

  /* Messages: here simply to fetch, don't export and use `getMessages()` instead */

  const { data: _messages } = useGetMessagesByConvoId(conversationId ?? '', {
    enabled: isAuthenticated,
  });

  const resetLatestMessage = useResetRecoilState(store.latestMessageFamily(index));
  const [isSubmitting, setIsSubmitting] = useRecoilState(store.isSubmittingFamily(index));
  const [latestMessage, setLatestMessage] = useRecoilState(store.latestMessageFamily(index));
  const setSiblingIdx = useSetRecoilState(
    store.messagesSiblingIdxFamily(latestMessage?.parentMessageId ?? null),
  );

  const setMessages = useCallback(
  (messages: TMessage[]) => {
    // Extract conversationId from the messages themselves (most reliable source)
    const messageConvoId = messages.length > 0 ? messages[0]?.conversationId : null;
    
    // Use message's conversationId if available, otherwise fall back to current state
    const targetConvoId = messageConvoId && messageConvoId !== 'new' 
      ? messageConvoId 
      : queryParam;
    
    console.log('📝 setMessages:', {
      messageConvoId,
      queryParam,
      conversationId,
      targetConvoId,
      messageCount: messages.length,
    });
    
    // Write to the primary cache key
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, targetConvoId], messages);
    
    // Also write to conversationId if it's different and valid
    if (conversationId && conversationId !== 'new' && conversationId !== targetConvoId) {
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, conversationId], messages);
    }
    
    // Also write to 'new' if target is a real convo ID (for backward compatibility)
    if (targetConvoId !== 'new' && queryParam === 'new') {
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, 'new'], messages);
    }
  },
  [queryParam, queryClient, conversationId],
);

  const getMessages = useCallback(() => {
    return queryClient.getQueryData<TMessage[]>([QueryKeys.messages, queryParam]);
  }, [queryParam, queryClient]);

  /* Conversation */
  // const setActiveConvos = useSetRecoilState(store.activeConversations);

  // const setConversation = useCallback(
  //   (convoUpdate: TConversation) => {
  //     _setConversation(prev => {
  //       const { conversationId: convoId } = prev ?? { conversationId: null };
  //       const { conversationId: currentId } = convoUpdate;
  //       if (currentId && convoId && convoId !== 'new' && convoId !== currentId) {
  //         // for now, we delete the prev convoId from activeConversations
  //         const newActiveConvos = { [currentId]: true };
  //         setActiveConvos(newActiveConvos);
  //       }
  //       return convoUpdate;
  //     });
  //   },
  //   [_setConversation, setActiveConvos],
  // );

  const setSubmission = useSetRecoilState(store.submissionByIndex(index));

  const { ask, regenerate } = useChatFunctions({
    index,
    files,
    setFiles,
    getMessages,
    setMessages,
    isSubmitting,
    conversation,
    latestMessage,
    setSubmission,
    setLatestMessage,
  });

  const continueGeneration = useCallback(() => {
    if (!latestMessage) {
      console.error('Failed to regenerate the message: latestMessage not found.');
      return;
    }

    const messages = getMessages();

    const parentMessage = messages?.find(
      (element) => element.messageId == latestMessage.parentMessageId,
    );

    if (parentMessage && parentMessage.isCreatedByUser) {
      ask({ ...parentMessage }, { isContinued: true, isRegenerate: true, isEdited: true });
    } else {
      console.error(
        'Failed to regenerate the message: parentMessage not found, or not created by user.',
      );
    }
  }, [latestMessage, getMessages, ask]);

  const stopGenerating = () => clearAllSubmissions();

  const handleStopGenerating = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    stopGenerating();
  };

  const handleRegenerate = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const parentMessageId = latestMessage?.parentMessageId ?? '';
    if (!parentMessageId) {
      console.error('Failed to regenerate the message: parentMessageId not found.');
      return;
    }
    regenerate({ parentMessageId });
  };

  const handleContinue = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    continueGeneration();
    setSiblingIdx(0);
  };

  const [showPopover, setShowPopover] = useRecoilState(store.showPopoverFamily(index));
  const [abortScroll, setAbortScroll] = useRecoilState(store.abortScrollFamily(index));
  const [preset, setPreset] = useRecoilState(store.presetByIndex(index));
  const [optionSettings, setOptionSettings] = useRecoilState(store.optionSettingsFamily(index));
  const [showAgentSettings, setShowAgentSettings] = useRecoilState(
    store.showAgentSettingsFamily(index),
  );

  // Detect and handle unfinished messages - restore UI state and resume polling
  useEffect(() => {
    if (!_messages || !conversation) {
      return;
    }

    // Check if we have unfinished messages
    const unfinishedMessages = _messages.filter(msg => 
      !msg.isCreatedByUser && msg.unfinished === true
    );

    if (unfinishedMessages.length === 0) {
      return;
    }

    const latestUnfinishedMessage = unfinishedMessages[unfinishedMessages.length - 1];
    
    // Only handle the latest unfinished message
    const sortedMessages = [..._messages].sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeA - timeB;
    });
    
    const actualLatestMessage = sortedMessages[sortedMessages.length - 1];
    
    if (actualLatestMessage?.messageId !== latestUnfinishedMessage.messageId) {
      console.log('Unfinished message is not the latest message, skipping');
      return;
    }

    // Only proceed if the message is recent (within last 5 minutes)
    if (latestUnfinishedMessage.createdAt) {
      const messageTime = new Date(latestUnfinishedMessage.createdAt).getTime();
      const now = new Date().getTime();
      const fiveMinutesAgo = now - (5 * 60 * 1000);
      
      if (messageTime < fiveMinutesAgo) {
        console.log('Unfinished message is too old, skipping');
        return;
      }
    }

    // Set this as the latest message to ensure proper UI state
    setLatestMessage(latestUnfinishedMessage);
    setIsSubmitting(true); // Show that we're waiting for completion

    console.log('🔄 Detected recent unfinished message, starting enhanced polling:');
    console.log('- Message ID:', latestUnfinishedMessage.messageId);
    console.log('- Conversation ID:', conversationId);
    console.log('- Current text length:', latestUnfinishedMessage.text?.length || 0);
    console.log('- Is unfinished:', latestUnfinishedMessage.unfinished);

    let previousMessageText = latestUnfinishedMessage.text || '';
    let pollCount = 0;

    // Enhanced polling that checks for actual message updates
    const pollForCompletion = () => {
      pollCount++;
      console.log(`📡 Polling attempt ${pollCount} for message completion...`);
      
      // Refetch the messages to get the latest state
      queryClient.refetchQueries([QueryKeys.messages, conversationId]).then(() => {
        const updatedMessages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]);
        const updatedMessage = updatedMessages?.find(msg => msg.messageId === latestUnfinishedMessage.messageId);
        
        if (updatedMessage) {
          console.log(`📋 Poll ${pollCount} - Message status:`, {
            unfinished: updatedMessage.unfinished,
            textLength: updatedMessage.text?.length || 0,
            hasNewText: updatedMessage.text !== previousMessageText
          });
          
          // Check if the message is no longer unfinished
          if (!updatedMessage.unfinished) {
            console.log('✅ Message completed! Clearing polling and updating UI');
            clearInterval(pollInterval);
            clearTimeout(timeout);
            setIsSubmitting(false);
            setLatestMessage(updatedMessage);
            return;
          }
          
          // Check if the text has been updated (partial streaming completion)
          if (updatedMessage.text && updatedMessage.text !== previousMessageText) {
            console.log('📝 Message text updated:', updatedMessage.text.length, 'characters');
            previousMessageText = updatedMessage.text;
            setLatestMessage(updatedMessage);
          }
        } else {
          console.log(`❌ Poll ${pollCount} - Message not found in updated data`);
        }
      }).catch(error => {
        console.error('❌ Error polling for message completion:', error);
      });
    };

    // Start with an immediate poll
    pollForCompletion();

    // Poll every 1.5 seconds for more responsive updates
    const pollInterval = setInterval(pollForCompletion, 1500);
    
    // Clean up after 2 minutes
    const timeout = setTimeout(() => {
      clearInterval(pollInterval);
      setIsSubmitting(false);
      console.log('⏰ Polling timeout reached for unfinished message after', pollCount, 'attempts');
    }, 120000);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(timeout);
      setIsSubmitting(false);
      console.log('🧹 Cleanup: Stopped polling for message completion');
    };
  }, [_messages, conversation, conversationId, setLatestMessage, setIsSubmitting, queryClient]);

  return {
    newConversation,
    conversation,
    setConversation,
    // getConvos,
    // setConvos,
    isSubmitting,
    setIsSubmitting,
    getMessages,
    setMessages,
    setSiblingIdx,
    latestMessage,
    setLatestMessage,
    resetLatestMessage,
    ask,
    index,
    regenerate,
    stopGenerating,
    handleStopGenerating,
    handleRegenerate,
    handleContinue,
    showPopover,
    setShowPopover,
    abortScroll,
    setAbortScroll,
    preset,
    setPreset,
    optionSettings,
    setOptionSettings,
    showAgentSettings,
    setShowAgentSettings,
    files,
    setFiles,
    filesLoading,
    setFilesLoading,
  };
}
