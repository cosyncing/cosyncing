#!/usr/bin/env node
// Reserve the loopback port the release fixture points $OPENCODE_URL at, for the whole capture run.
//
//   node scripts/dev/hold-opencode-port.mjs <port-file>
//
// OpenCode is the one adapter a redirected HOME does not isolate: it discovers over HTTP at
// $OPENCODE_URL, so the fixture aims it somewhere that answers nothing. Checking that the address
// is dead is not the same as it staying dead — between the check and the capture, a real OpenCode
// server can bind it, and the roster fills with somebody's actual projects. That is not
// hypothetical: the first fixture run published 243 real sessions.
//
// So the address is held rather than merely tested. This binds an ephemeral loopback port, writes
// the number to <port-file>, and stays up for the life of the run destroying every connection it
// accepts. Nothing else can take the port, and anything that connects to it gets a reset — which is
// exactly what "no OpenCode server here" looks like to the adapter.
//
// The runner starts this before seeding and kills it at the end.

import { createServer } from "node:net";
import { writeFileSync } from "node:fs";

const portFile = process.argv[2];
if (!portFile) {
  console.error("usage: hold-opencode-port.mjs <port-file>");
  process.exit(2);
}

const server = createServer((socket) => socket.destroy());
server.on("error", (error) => {
  console.error(`could not reserve a loopback port: ${error.message}`);
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(portFile, `${port}\n`);
  console.log(`holding 127.0.0.1:${port} so no OpenCode server can occupy it`);
});
