import { EventEmitter } from 'events';

class SyncBus extends EventEmitter {}

export const syncBus = new SyncBus();
syncBus.setMaxListeners(250);
