#!/usr/bin/env bun
import { loadOrCreateBrokerInstanceId } from '../../src/runtime/broker-instance.ts';

const home = process.argv[2];
if (!home) throw new Error('state home argument is required');
process.stdout.write(`${loadOrCreateBrokerInstanceId(home)}\n`);
