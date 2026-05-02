import { Buffer } from 'node:buffer';
import {
  type ActionRowBuilder,
  AttachmentBuilder,
  type ButtonBuilder,
  EmbedBuilder,
  type APIEmbed,
  type Message,
} from 'discord.js';

const DEBOUNCE_MS = 500;
const MESSAGE_SOFT_LIMIT = 1900;
const DISCORD_HARD_LIMIT = 2000;

const PROCESSING_LINE = '⏳ processing...';
const NO_OUTPUT = '(no output)';
const EXPLICIT_ATTACHMENT_NOTICE = '📎 see attachment';

export interface SendableChannel {
  send(options: string | SendOptions): Promise<Message<boolean>>;
}

interface SendOptions {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
}

export interface StreamHandle {
  append(delta: string): void;
  attach(filename: string, content: string): Promise<void>;
  finish(): Promise<void>;
  failWith(embed: APIEmbed): Promise<void>;
}

export interface DiscordStreamer {
  begin(channel: SendableChannel, header?: string): Promise<StreamHandle>;
}

export function createDiscordStreamer(): DiscordStreamer {
  return {
    async begin(
      channel: SendableChannel,
      header?: string,
    ): Promise<StreamHandle> {
      const sendable = channel;
      const initialContent = withHeader(header, PROCESSING_LINE);
      const initialMessage = await safeSend(sendable, initialContent);

      if (initialMessage === undefined) {
        return createNoopStreamHandle();
      }

      let buffer = '';
      let currentMsg: Message<boolean> = initialMessage;
      let currentBody = '';
      let flushTimer: NodeJS.Timeout | undefined;
      let flushing: Promise<void> = Promise.resolve();
      let finished = false;

      const editCurrent = async (options: string | SendOptions): Promise<void> => {
        try {
          await currentMsg.edit(options);
        } catch (err) {
          console.error('[stream]', err);
        }
      };

      const sendFollowUp = async (options: string | SendOptions): Promise<Message<boolean> | undefined> => {
        try {
          return await sendable.send(options);
        } catch (err) {
          console.error('[stream]', err);
          return undefined;
        }
      };

      const cancelFlushTimer = (): void => {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
      };

      const enqueueFlush = (): Promise<void> => {
        flushing = flushing
          .then(doFlush)
          .catch((err: unknown) => {
            console.error('[stream]', err);
          });
        return flushing;
      };

      const scheduleFlush = (): void => {
        if (flushTimer !== undefined || finished) {
          return;
        }

        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void enqueueFlush();
        }, DEBOUNCE_MS);
      };

      async function doFlush(): Promise<void> {
        if (buffer.length === 0) {
          return;
        }

        const pending = buffer;
        buffer = '';

        if (currentBody.length + pending.length < MESSAGE_SOFT_LIMIT) {
          currentBody += pending;
          await editCurrent(finalContent(header, currentBody));
          return;
        }

        let remaining = pending;
        const currentCapacity = Math.max(DISCORD_HARD_LIMIT - currentBody.length, 0);

        if (currentCapacity > 0) {
          const fit = remaining.slice(0, currentCapacity);
          remaining = remaining.slice(currentCapacity);
          currentBody += fit;
          await editCurrent(finalContent(header, currentBody));
        }

        while (remaining.length > 0) {
          const chunk = remaining.slice(0, DISCORD_HARD_LIMIT);
          remaining = remaining.slice(DISCORD_HARD_LIMIT);

          const nextMsg = await sendFollowUp(chunk);
          if (nextMsg === undefined) {
            buffer = remaining;
            return;
          }

          currentMsg = nextMsg;
          currentBody = chunk;
        }
      }

      const uploadAttachment = async (filename: string, content: string, notice: string): Promise<void> => {
        const attachment = new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: filename });
        await editCurrent(withHeader(header, notice));
        await sendFollowUp({ files: [attachment] });
      };

      return {
        append(delta: string): void {
          if (finished) {
            return;
          }

          buffer += delta;
          scheduleFlush();
        },

        async attach(filename: string, content: string): Promise<void> {
          if (finished) {
            return;
          }

          cancelFlushTimer();
          await flushing;
          await uploadAttachment(filename, content, EXPLICIT_ATTACHMENT_NOTICE);
        },

        async finish(): Promise<void> {
          if (finished) {
            return;
          }

          finished = true;
          cancelFlushTimer();

          await enqueueFlush();

          if (currentBody.length === 0) {
            await editCurrent(withHeader(header, NO_OUTPUT));
            return;
          }

          await editCurrent(finalContent(header, stripProcessingSuffix(currentBody)));
        },

        async failWith(embed: APIEmbed): Promise<void> {
          finished = true;
          cancelFlushTimer();
          buffer = '';

          const failureEmbed = EmbedBuilder.from(embed).setColor(0xff0000);
          await editCurrent({ content: '', embeds: [failureEmbed] });
        },
      };
    },
  };
}

async function safeSend(
  channel: SendableChannel,
  content: string,
): Promise<Message<boolean> | undefined> {
  try {
    return await channel.send(content);
  } catch (err) {
    console.error('[stream]', err);
    return undefined;
  }
}

function createNoopStreamHandle(): StreamHandle {
  return {
    append(): void {
      return;
    },
    async attach(): Promise<void> {
      return;
    },
    async finish(): Promise<void> {
      return;
    },
    async failWith(): Promise<void> {
      return;
    },
  };
}

function withHeader(header: string | undefined, body: string): string {
  return header === undefined || header.length === 0 ? body : `${header}\n${body}`;
}

function finalContent(header: string | undefined, body: string): string {
  return withHeader(header, body.length === 0 ? NO_OUTPUT : body).slice(0, DISCORD_HARD_LIMIT);
}

function stripProcessingSuffix(body: string): string {
  return body.endsWith(PROCESSING_LINE) ? body.slice(0, -PROCESSING_LINE.length).trimEnd() : body;
}
