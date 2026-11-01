// The NEAR libraries reach for Node's Buffer; browsers don't have one.
import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;
