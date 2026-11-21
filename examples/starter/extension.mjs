import { joinSession } from '@github/copilot-sdk/extension';
import { greetingCommand } from './command.mjs';

let session;
session = await joinSession({ commands: [greetingCommand(() => session)] });
