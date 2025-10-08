import { v4 } from 'uuid';
import { useCallback, useRef } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Constants, replaceSpecialVars } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useAuthContext } from '~/hooks/AuthContext';
import store from '~/store';

const appendIndex = (index: number, value?: string) => {
  if (!value) {
    return value;
  }
  return `${value}${Constants.COMMON_DIVIDER}${index}`;
};

export default function useSubmitMessage() {
  const { user } = useAuthContext();
  const methods = useChatFormContext();
  const { ask, index, getMessages, setMessages, latestMessage } = useChatContext();
  const { addedIndex, ask: askAdditional, conversation: addedConvo } = useAddedChatContext();

  const autoSendPrompts = useRecoilValue(store.autoSendPrompts);
  const activeConvos = useRecoilValue(store.allConversationsSelector);
  const setActivePrompt = useSetRecoilState(store.activePromptByIndex(index));
  // Guard against rapid duplicate submissions (double enter / double click / focus changes)
  const lastSubmitRef = useRef<{ text: string; ts: number }>({ text: '', ts: 0 });

  const submitMessage = useCallback(
    (data?: { text: string }) => {
      if (!data) {
        return console.warn('No data provided to submitMessage');
      }
      const now = Date.now();
      const last = lastSubmitRef.current;
      const normalizedText = (data.text ?? '').trim();
      if (normalizedText.length === 0) {
        return;
      }
      // Ignore same-text submit within 1.5s window to prevent accidental resubmits
      if (last.text === normalizedText && now - last.ts < 1500) {
        return;
      }
      lastSubmitRef.current = { text: normalizedText, ts: now };
      const rootMessagesRaw = getMessages();
      const rootMessages = Array.isArray(rootMessagesRaw)
        ? (rootMessagesRaw.filter(Boolean) as any[])
        : [];
      const latestId = latestMessage?.messageId;
      const isLatestInRootMessages =
        latestId != null ? rootMessages.some((message: any) => message?.messageId === latestId) : true;
      if (!isLatestInRootMessages && latestMessage) {
        setMessages([...(rootMessages as any[]), latestMessage]);
      }

      const hasAdded = addedIndex && activeConvos[addedIndex] && addedConvo;
      const isNewMultiConvo =
        hasAdded &&
        activeConvos.every((convoId) => convoId === Constants.NEW_CONVO) &&
        !rootMessages?.length;
      const overrideConvoId = isNewMultiConvo ? v4() : undefined;
      const overrideUserMessageId = hasAdded ? v4() : undefined;
      const rootIndex = addedIndex - 1;
      const clientTimestamp = new Date().toISOString();
      // Ensure text in form stays in sync after debounce guard
      methods.setValue('text', normalizedText, { shouldValidate: true, shouldDirty: true });

      ask({
        text: normalizedText,
        overrideConvoId: appendIndex(rootIndex, overrideConvoId),
        overrideUserMessageId: appendIndex(rootIndex, overrideUserMessageId),
        clientTimestamp,
      });

      if (hasAdded) {
        askAdditional(
          {
            text: normalizedText,
            overrideConvoId: appendIndex(addedIndex, overrideConvoId),
            overrideUserMessageId: appendIndex(addedIndex, overrideUserMessageId),
            clientTimestamp,
          },
          { overrideMessages: rootMessages },
        );
      }
      methods.reset();
    },
    [
      ask,
      methods,
      addedIndex,
      addedConvo,
      setMessages,
      getMessages,
      activeConvos,
      askAdditional,
      latestMessage,
    ],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      const parsedText = replaceSpecialVars({ text, user });
      if (autoSendPrompts) {
        submitMessage({ text: parsedText });
        return;
      }

      const currentText = methods.getValues('text');
      const newText = currentText.trim().length > 1 ? `\n${parsedText}` : parsedText;
      setActivePrompt(newText);
    },
    [autoSendPrompts, submitMessage, setActivePrompt, methods, user],
  );

  return { submitMessage, submitPrompt };
}
