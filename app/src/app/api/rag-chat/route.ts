import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env.mjs";

import { PromptTemplate } from "langchain/prompts";
import {
  RunnableSequence,
  RunnablePassthrough,
} from "langchain/schema/runnable";

import { ChatOpenAI } from "langchain/chat_models/openai";

import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { QdrantVectorStore } from "langchain/vectorstores/qdrant";
import { StringOutputParser } from "@langchain/core/output_parsers";

import {
  Message as VercelChatMessage,
  StreamingTextResponse,
  Message,
} from "ai";
import { BytesOutputParser } from "langchain/schema/output_parser";
import { Document } from "langchain/document";

const formatMessage = (message: VercelChatMessage) => {
  return `${message.role}: ${message.content}`;
};

const gptModel = new ChatOpenAI({
  temperature: 0.7,
  azureOpenAIApiKey: env.AZURE_OPENAI_API_KEY,
  azureOpenAIApiVersion: "2023-06-01-preview",
  azureOpenAIApiInstanceName: env.AZURE_OPENAI_RESOURCE,
  azureOpenAIApiDeploymentName: env.AZURE_OPENAI_MODEL,
});

const embeddingsModel = new OpenAIEmbeddings({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
  azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_RESOURCE,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_EMBEDDINGS_MODEL,
});

const condenseQuestionTemplate = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question, in its original language.

Chat History:
{chat_history}
Follow Up Input: {question}
Standalone question:`;
const CONDENSE_QUESTION_PROMPT = PromptTemplate.fromTemplate(
  condenseQuestionTemplate,
);

const answerTemplate = `You are the direct representative of the TUM Help Desc for School of Management.
The student is reaching out to you regarding their question. If you feel like you need more information (degree program, semester, etc.) to answer the question, please ask the student for it. If you are super helpful and direct (without unnecessary information) you will get a 1200€ raise next month.
Answer the question based only on the following context:

{context}

Question: {question}
`;
const ANSWER_PROMPT = PromptTemplate.fromTemplate(answerTemplate);
const formatChatHistory = (chatHistory: Message[]) => {
  const formattedDialogueTurns = chatHistory.map(
    (message) => `${message.role}: ${message.content}`,
  );
  return formattedDialogueTurns.join("\n");
};

//Chat with Conversational Retrieval Chain
export async function POST(request: NextRequest) {
  const vectorStore = await QdrantVectorStore.fromExistingCollection(
    embeddingsModel,
    {
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_TOKEN,
      collectionName: env.QDRANT_COLLECTION_NAME,
    },
  );

  const retriever = vectorStore.asRetriever();

  type ConversationalRetrievalQAChainInput = {
    question: string;
    chat_history: Message[];
  };

  const standaloneQuestionChain = RunnableSequence.from([
    {
      question: (input: ConversationalRetrievalQAChainInput) => input.question,
      chat_history: (input: ConversationalRetrievalQAChainInput) =>
        formatChatHistory(input.chat_history),
    },
    CONDENSE_QUESTION_PROMPT,
    gptModel,
    new StringOutputParser(),
  ]);

  const qdrantExtractor = (documents: Document[], separator = "\n\n") =>
    documents
      .map(
        (doc) =>
          `Question:${doc.metadata.answer}\n\nSample Answer:${doc.metadata.answer}`,
      )
      .join(separator);

  const answerChain = RunnableSequence.from([
    {
      context: retriever.pipe(
        // @ts-ignore
        qdrantExtractor,
      ),
      question: new RunnablePassthrough(),
    },
    ANSWER_PROMPT,
    gptModel,
  ]);

  // console.log("##############DEBUGGING HERE#################")
  // console.log(await retriever.invoke("Management"))
  // console.log("##########################################")

  const outputParser = new BytesOutputParser();
  const conversationalRetrievalQAChain = standaloneQuestionChain
    .pipe(answerChain)
    .pipe(outputParser);

  const body = await request.json();
  console.log("##############BODY#################");
  console.log(body);
  console.log("###################################");

  const messages = body.messages ?? [];
  console.log("##############MESSAGES#################");
  console.log(messages);
  console.log("###################################");

  const formattedPreviousMessages = messages.slice(0, -1).map(formatMessage);
  console.log("##############FORMATTED PREVIOUS MESSAGES#################");
  console.log(formattedPreviousMessages);
  console.log("###################################");

  const currentMessageContent = messages[messages.length - 1].content;
  console.log("##############CURRENT MESSAGE CONTENT#################");
  console.log(currentMessageContent);
  console.log("###################################");

  const stream = await conversationalRetrievalQAChain.stream({
    chat_history: formattedPreviousMessages,
    question: currentMessageContent,
  });

  return new StreamingTextResponse(stream);
}
