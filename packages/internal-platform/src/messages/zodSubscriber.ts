import {
  Client as PulsarClient,
  Consumer as PulsarConsumer,
  ConsumerConfig as PulsarConsumerConfig,
  Message as PulsarMessage,
} from "pulsar-client";
import { Logger } from "../logger";
import {
  MessageCatalogSchema,
  MessageData,
  MessageDataSchema,
} from "./messageCatalogSchema";

import { z, ZodError } from "zod";

export type ZodSubscriberHandlers<
  TConsumerSchema extends MessageCatalogSchema
> = {
  [K in keyof TConsumerSchema]: (
    id: string,
    data: z.infer<TConsumerSchema[K]["data"]>,
    properties: z.infer<TConsumerSchema[K]["properties"]>
  ) => Promise<boolean>;
};

export type ZodSubscriberOptions<
  SubscriberSchema extends MessageCatalogSchema
> = {
  client: PulsarClient;
  config: Omit<PulsarConsumerConfig, "listener">;
  schema: SubscriberSchema;
  handlers: ZodSubscriberHandlers<SubscriberSchema>;
};

export class ZodSubscriber<SubscriberSchema extends MessageCatalogSchema> {
  #config: Omit<PulsarConsumerConfig, "listener">;
  #schema: SubscriberSchema;
  #handlers: ZodSubscriberHandlers<SubscriberSchema>;

  #subscriber?: PulsarConsumer;
  #client: PulsarClient;

  #logger: Logger;

  constructor(options: ZodSubscriberOptions<SubscriberSchema>) {
    this.#config = options.config;
    this.#schema = options.schema;
    this.#handlers = options.handlers;
    this.#client = options.client;
    this.#logger = new Logger("trigger.dev subscriber", "info");
  }

  public async initialize(): Promise<boolean> {
    try {
      this.#logger.debug(
        `Initializing subscriber with config ${JSON.stringify(this.#config)}`
      );

      this.#subscriber = await this.#client.subscribe({
        ...this.#config,
        listener: this.#onMessage.bind(this),
      });

      return true;
    } catch (e) {
      this.#logger.error("Error initializing subscriber", e);

      return false;
    }
  }

  public async close() {
    if (this.#subscriber) {
      await this.#subscriber.close();
      this.#subscriber = undefined;
    }
  }

  #getRawProperties(msg: PulsarMessage): Record<string, string> {
    const properties = msg.getProperties();

    if (Array.isArray(properties)) {
      return Object.keys(properties).reduce((acc, key) => {
        acc[key] = properties[key];

        return acc;
      }, {} as Record<string, string>);
    }

    return properties;
  }

  async #onMessage(msg: PulsarMessage, consumer: PulsarConsumer) {
    const messageData = MessageDataSchema.parse(
      JSON.parse(msg.getData().toString())
    );

    const properties = this.#getRawProperties(msg);

    try {
      const wasHandled = await this.#handleMessage(messageData, properties);

      if (wasHandled) {
        await consumer.acknowledge(msg);
      }
    } catch (e) {
      if (e instanceof ZodError) {
        this.#logger.error(
          "[ZodSubscriber] Received invalid message data or properties",
          messageData,
          properties,
          e.format()
        );
      } else {
        this.#logger.error("[ZodSubscriber] Error handling message", e);
      }

      consumer.negativeAcknowledge(msg);
    }
  }

  async #handleMessage<K extends keyof SubscriberSchema>(
    rawMessage: MessageData,
    rawProperties: Record<string, string> = {}
  ): Promise<boolean> {
    const subscriberSchema = this.#schema;
    type TypeKeys = keyof typeof subscriberSchema;
    const typeName = rawMessage.type as TypeKeys;

    const messageSchema: SubscriberSchema[TypeKeys] | undefined =
      subscriberSchema[typeName];

    if (!messageSchema) {
      throw new Error(`Unknown message type: ${rawMessage.type}`);
    }

    this.#logger.info(
      `Handling message of type ${rawMessage.type}, parsing data and properties`,
      rawMessage.data,
      rawProperties
    );

    const message = messageSchema.data.parse(rawMessage.data);
    const properties = messageSchema.properties.parse(rawProperties);

    const handler = this.#handlers[typeName];

    const returnValue = await handler(rawMessage.id, message, properties);

    return returnValue;
  }
}