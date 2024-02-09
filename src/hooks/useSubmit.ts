import useStore from '@store/store';
import { useTranslation } from 'react-i18next';
import { DocumentInterface, MessageInterface } from '@type/document';
import { getChatCompletion, getChatCompletionStream } from '@api/api';
import { parseEventSource } from '@api/helper';
import { limitMessageTokens, updateTotalTokenUsed } from '@utils/messageUtils';
import { _defaultChatConfig } from '@constants/chat';
import { officialAPIEndpoint } from '@constants/auth';
import useUpdateHistory from './useUpdateHistory';

const useSubmit = () => {
  const { t, i18n } = useTranslation('api');
  const error = useStore((state) => state.error);
  const setError = useStore((state) => state.setError);
  const apiEndpoint = useStore((state) => state.apiEndpoint);
  const apiKey = useStore((state) => state.apiKey);
  const setGenerating = useStore((state) => state.setGenerating);
  const generating = useStore((state) => state.generating);
  const currentChatIndex = useStore((state) => state.currentDocumentIndex);
  const setChats = useStore((state) => state.setDocuments);

  const generateTitle = async (
    message: MessageInterface[]
  ): Promise<string> => {
    let data;
    if (!apiKey || apiKey.length === 0) {
      // official endpoint
      if (apiEndpoint === officialAPIEndpoint) {
        throw new Error(t('noApiKeyWarning') as string);
      }

      // other endpoints
      data = await getChatCompletion(
        useStore.getState().apiEndpoint,
        message,
        _defaultChatConfig
      );
    } else if (apiKey) {
      // own apikey
      data = await getChatCompletion(
        useStore.getState().apiEndpoint,
        message,
        _defaultChatConfig,
        apiKey
      );
    }
    return data.choices[0].message.content;
  };

  const handleSubmit = async () => {
    const chats = useStore.getState().documents;
    if (generating || !chats) return;

    const updatedChats: DocumentInterface[] = JSON.parse(JSON.stringify(chats));
    const defaultChatConfig = useStore.getState().defaultChatConfig;

    const config = updatedChats[currentChatIndex].messageCurrent.config ? updatedChats[currentChatIndex].messageCurrent.config : defaultChatConfig;

    updatedChats[currentChatIndex].messageCurrent.messages.push({
      role: 'assistant',
      content: '',
    });

    setChats(updatedChats);
    setGenerating(true);

    try {
      let stream;
      if (chats[currentChatIndex].messageCurrent.messages.length === 0)
        throw new Error('No messages submitted!');


//       const messages = limitMessageTokens(
//         chats[currentChatIndex].messageCurrent.messages,
// //        undefined,
//         config? config.max_tokens : defaultChatConfig.max_tokens,
//         config? config.model : defaultChatConfig.model,
//       );

      const messages = chats[currentChatIndex].messageCurrent.messages;

      if (messages.length === 0) throw new Error('Message exceed max token!');

      // no api key (free)
      if (!apiKey || apiKey.length === 0) {
        // official endpoint
        if (apiEndpoint === officialAPIEndpoint) {
          throw new Error(t('noApiKeyWarning') as string);
        }

        // other endpoints
        stream = await getChatCompletionStream(
          useStore.getState().apiEndpoint,
          messages,
          config ? config : defaultChatConfig
        );
      } else if (apiKey) {
        // own apikey
        stream = await getChatCompletionStream(
          useStore.getState().apiEndpoint,
          messages,
          config ? config : defaultChatConfig,
          apiKey
        );
      }

      if (stream) {
        if (stream.locked)
          throw new Error(
            'Oops, the stream is locked right now. Please try again'
          );
        const reader = stream.getReader();
        let reading = true;
        let partial = '';
        while (reading && useStore.getState().generating) {
          const { done, value } = await reader.read();
          const result = parseEventSource(
            partial + new TextDecoder().decode(value)
          );
          partial = '';

          if (result === '[DONE]' || done) {
            reading = false;
          } else {
            const resultString = result.reduce((output: string, curr) => {
              if (typeof curr === 'string') {
                partial += curr;
              } else {
                const content = curr.choices[0].delta.content;
                if (content) output += content;
              }
              return output;
            }, '');

            const updatedChats: DocumentInterface[] = JSON.parse(
              JSON.stringify(useStore.getState().documents)
            );

            // Check the history to see if it matches the current message
//            const messageHistory = updatedChats[currentChatIndex].messageHistory;
//            let matchFound = false;
             const updatedMessages = updatedChats[currentChatIndex].messageCurrent.messages;
             updatedMessages[updatedMessages.length - 1].content += resultString;
             updatedChats[currentChatIndex].messageCurrent.messages = updatedMessages;
             let matchFound = false;
            let messageHistory = updatedChats[currentChatIndex].messageHistory;


            for(let i = 0; i < messageHistory.length; i++) {
              if (messageHistory[i].id == updatedChats[currentChatIndex].messageCurrent.id) {
                messageHistory[i] = updatedChats[currentChatIndex].messageCurrent;
                matchFound = true;
              }
            }

            if (!matchFound) {
              messageHistory.push(updatedChats[currentChatIndex].messageCurrent);
            }

              updatedChats[currentChatIndex].messageHistory = messageHistory;
              setChats(updatedChats);
          }
        }
        if (useStore.getState().generating) {
          reader.cancel('Cancelled by user');
        } else {
          reader.cancel('Generation completed');
        }
        reader.releaseLock();
        stream.cancel();
      }



      // update tokens used in chatting
      const currChats = useStore.getState().documents;
      const countTotalTokens = useStore.getState().countTotalTokens;

      if (currChats && countTotalTokens) {
        const model = config ? config.model : defaultChatConfig.model;
        const messages = currChats[currentChatIndex].messageCurrent.messages;
        updateTotalTokenUsed(
          model,
          messages.slice(0, -1),
          messages[messages.length - 1]
        );
      }

      // generate title for new chats
      if (
        useStore.getState().autoTitle &&
        currChats &&
        !currChats[currentChatIndex]?.titleSet
      ) {
        const messages_length = currChats[currentChatIndex].messageCurrent.messages.length;
        const assistant_message =
          currChats[currentChatIndex].messageCurrent.messages[messages_length - 1].content;
        const user_message =
          currChats[currentChatIndex].messageCurrent.messages[messages_length - 2].content;

        const message: MessageInterface = {
          role: 'user',
          content: `Generate a title in less than 6 words for the following message (language: ${i18n.language}):\n"""\nUser: ${user_message}\nAssistant: ${assistant_message}\n"""`,
        };

        let title = (await generateTitle([message])).trim();
        if (title.startsWith('"') && title.endsWith('"')) {
          title = title.slice(1, -1);
        }
        const updatedChats: DocumentInterface[] = JSON.parse(
          JSON.stringify(useStore.getState().documents)
        );
        updatedChats[currentChatIndex].title = title;
        updatedChats[currentChatIndex].titleSet = true;
        setChats(updatedChats);

        // update tokens used for generating title
        if (countTotalTokens) {
          const model = config ? config.model : defaultChatConfig.model;
          updateTotalTokenUsed(model, [message], {
            role: 'assistant',
            content: title,
          });
        }
      }

      
    } catch (e: unknown) {
      const err = (e as Error).message;
      console.log(err);
      setError(err);
    }
    setGenerating(false);
  };

  return { handleSubmit, error };
};

export default useSubmit;
