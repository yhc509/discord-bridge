import { auditCommand } from './audit.js';
import { bindCommand, buttonHandlers as bindButtonHandlers } from './bind.js';
import { compactCommand } from './compact.js';
import { endCommand } from './end.js';
import { helpCommand } from './help.js';
import { killCommand, buttonHandlers as killButtonHandlers } from './kill.js';
import { interruptCommand } from './interrupt.js';
import { listCommand } from './list.js';
import { newCommand } from './new.js';
import { queueCommand } from './queue.js';
import { reloadCommand } from './reload.js';
import { statusCommand } from './status.js';
import { unbindCommand, buttonHandlers as unbindButtonHandlers } from './unbind.js';
import { usageCommand } from './usage.js';
import type { ButtonHandler, SlashCommand } from './types.js';

export const slashCommands: SlashCommand[] = [
  auditCommand,
  bindCommand,
  newCommand,
  compactCommand,
  endCommand,
  killCommand,
  interruptCommand,
  queueCommand,
  usageCommand,
  statusCommand,
  listCommand,
  reloadCommand,
  unbindCommand,
  helpCommand,
];

export const buttonHandlers: ButtonHandler[] = [
  ...bindButtonHandlers,
  ...killButtonHandlers,
  ...unbindButtonHandlers,
];

export function findCommandByName(name: string): SlashCommand | undefined {
  return slashCommands.find((command) => command.data.name === name);
}

export function findButtonHandler(customId: string): ButtonHandler | undefined {
  return buttonHandlers.find((handler) =>
    customId.startsWith(handler.customIdPrefix),
  );
}
